#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * Standalone WebSocket service for Kalshi real-time updates
 * 
 * Run this as a persistent service:
 *   deno run --allow-net --allow-env scripts/websocket-service.ts
 * 
 * Or deploy to Railway/Render/etc. as a Deno service
 * 
 * Environment Variables Required:
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - KALSHI_API_KEY_ID
 *   - KALSHI_PRIVATE_KEY (full PEM format with headers)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const KALSHI_API_KEY_ID = Deno.env.get("KALSHI_API_KEY_ID");
const KALSHI_PRIVATE_KEY = Deno.env.get("KALSHI_PRIVATE_KEY");
const KALSHI_WS_URL = Deno.env.get("KALSHI_WS_URL") || "wss://api.elections.kalshi.com/trade-api/ws/v2";

// Debug: Log all environment variable names (not values for security)
console.log("Environment variables check:");
console.log("- SUPABASE_URL:", SUPABASE_URL ? `✅ Set (${SUPABASE_URL.length} chars)` : "❌ Missing");
console.log("- SUPABASE_SERVICE_ROLE_KEY:", SUPABASE_SERVICE_ROLE_KEY ? `✅ Set (${SUPABASE_SERVICE_ROLE_KEY.length} chars)` : "❌ Missing");
console.log("- KALSHI_API_KEY_ID:", KALSHI_API_KEY_ID ? `✅ Set (${KALSHI_API_KEY_ID.length} chars)` : "❌ Missing");
console.log("- KALSHI_PRIVATE_KEY:", KALSHI_PRIVATE_KEY ? `✅ Set (${KALSHI_PRIVATE_KEY.length} chars)` : "❌ Missing");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase credentials");
  console.error("SUPABASE_URL:", SUPABASE_URL ? "present" : "MISSING");
  console.error("SUPABASE_SERVICE_ROLE_KEY:", SUPABASE_SERVICE_ROLE_KEY ? "present" : "MISSING");
  Deno.exit(1);
}

if (!KALSHI_API_KEY_ID || !KALSHI_PRIVATE_KEY) {
  console.error("❌ Missing Kalshi credentials");
  console.error("KALSHI_API_KEY_ID:", KALSHI_API_KEY_ID ? "present" : "MISSING");
  console.error("KALSHI_PRIVATE_KEY:", KALSHI_PRIVATE_KEY ? "present" : "MISSING");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Handle both PKCS#8 and PKCS#1 formats
  const pemHeaderPKCS8 = "-----BEGIN PRIVATE KEY-----";
  const pemFooterPKCS8 = "-----END PRIVATE KEY-----";
  const pemHeaderPKCS1 = "-----BEGIN RSA PRIVATE KEY-----";
  const pemFooterPKCS1 = "-----END RSA PRIVATE KEY-----";
  
  let pemContents = pem;
  let isPKCS8 = false;
  
  if (pem.includes(pemHeaderPKCS8)) {
    pemContents = pem
      .replace(pemHeaderPKCS8, "")
      .replace(pemFooterPKCS8, "")
      .replace(/\s/g, "");
    isPKCS8 = true;
  } else if (pem.includes(pemHeaderPKCS1)) {
    pemContents = pem
      .replace(pemHeaderPKCS1, "")
      .replace(pemFooterPKCS1, "")
      .replace(/\s/g, "");
    isPKCS8 = false;
    console.warn("⚠️ PKCS#1 format detected. This may cause issues. Please convert to PKCS#8 format.");
  } else {
    // Try to parse as raw base64
    pemContents = pem.replace(/\s/g, "");
  }

  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  if (!isPKCS8) {
    throw new Error("Private key must be in PKCS#8 format (-----BEGIN PRIVATE KEY-----). Please convert your key using: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem");
  }
  
  return bytes.buffer;
}

async function connectKalshiWebSocket(): Promise<WebSocket> {
  try {
    const timestamp = Date.now().toString();
    const path = "/trade-api/ws/v2";
    const message = timestamp + "GET" + path;

    console.log("Importing private key...");
    console.log("Key preview:", KALSHI_PRIVATE_KEY?.substring(0, 50) + "...");
    
    let keyBuffer: ArrayBuffer;
    try {
      keyBuffer = pemToArrayBuffer(KALSHI_PRIVATE_KEY!);
    } catch (keyError: any) {
      console.error("❌ Key parsing error:", keyError.message);
      throw new Error(`Invalid key format: ${keyError.message}. Make sure the key is in PKCS#8 format with -----BEGIN PRIVATE KEY----- headers.`);
    }
    
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBuffer,
      { name: "RSA-PSS", hash: "SHA-256" },
      false,
      ["sign"]
    );

    console.log("Signing message...");
    const signature = await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      privateKey,
      new TextEncoder().encode(message)
    );

    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    const wsUrl = `${KALSHI_WS_URL}?KALSHI-ACCESS-KEY=${KALSHI_API_KEY_ID}&KALSHI-ACCESS-TIMESTAMP=${timestamp}&KALSHI-ACCESS-SIGNATURE=${signatureB64}`;

    console.log("Connecting to Kalshi WebSocket...");
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("✅ Connected to Kalshi WebSocket");
      ws.send(JSON.stringify({
        type: "subscribe",
        channels: ["market_data"],
      }));
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log("📨 Received:", message.type);

        if (message.type === "market_update" || message.type === "trade") {
          await handleMarketUpdate(message);
        } else if (message.type === "orderbook_update") {
          await handleOrderbookUpdate(message);
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("❌ WebSocket error:", error);
    };

    ws.onclose = (event) => {
      console.log(`⚠️ WebSocket closed (code: ${event.code}), reconnecting in 5 seconds...`);
      setTimeout(() => {
        connectKalshiWebSocket().catch((err) => {
          console.error("Failed to reconnect:", err);
        });
      }, 5000);
    };

    return ws;
  } catch (error) {
    console.error("❌ Error connecting to WebSocket:", error);
    throw error;
  }
}

async function handleMarketUpdate(message: any) {
  const ticker = message.ticker || message.market_ticker;
  if (!ticker) return;

  const update: any = {
    yes_price_last: message.yes_price,
    no_price_last: message.no_price,
    volume: message.volume,
    status: message.status,
    updated_at: new Date().toISOString(),
  };

  // Remove null values
  Object.keys(update).forEach(key => {
    if (update[key] === null || update[key] === undefined) {
      delete update[key];
    }
  });

  const { error } = await supabase
    .from("markets")
    .update(update)
    .eq("venue", "kalshi")
    .eq("venue_market_ticker", ticker);

  if (error) {
    console.error(`Error updating ${ticker}:`, error);
  } else {
    console.log(`✅ Updated ${ticker}`);
  }
}

async function handleOrderbookUpdate(message: any) {
  const ticker = message.ticker || message.market_ticker;
  if (!ticker) return;

  const { data: market } = await supabase
    .from("markets")
    .select("id")
    .eq("venue", "kalshi")
    .eq("venue_market_ticker", ticker)
    .single();

  if (!market) return;

  const orderbook = message.orderbook || {};
  const yes = orderbook.yes || [];
  const no = orderbook.no || [];
  const [yesPrice, yesQty] = yes.length ? yes[0] : [null, null];
  const [noPrice, noQty] = no.length ? no[0] : [null, null];

  await supabase.from("market_quotes").insert({
    market_id: market.id,
    yes_best_bid: yesPrice,
    yes_best_bid_qty: yesQty,
    no_best_bid: noPrice,
    no_best_bid_qty: noQty,
    yes_price_last: message.yes_price,
    no_price_last: message.no_price,
    orderbook_raw: orderbook,
  });
}

// Start the WebSocket connection
console.log("🚀 Starting Kalshi WebSocket service...");
console.log("Environment check:");
console.log("- SUPABASE_URL:", SUPABASE_URL ? "✅ Set" : "❌ Missing");
console.log("- SUPABASE_SERVICE_ROLE_KEY:", SUPABASE_SERVICE_ROLE_KEY ? "✅ Set" : "❌ Missing");
console.log("- KALSHI_API_KEY_ID:", KALSHI_API_KEY_ID ? "✅ Set" : "❌ Missing");
console.log("- KALSHI_PRIVATE_KEY:", KALSHI_PRIVATE_KEY ? `✅ Set (${KALSHI_PRIVATE_KEY.length} chars)` : "❌ Missing");

// Handle errors and keep process alive
(async () => {
  try {
    console.log("Attempting to connect to Kalshi WebSocket...");
    await connectKalshiWebSocket();
    console.log("WebSocket connection initiated successfully");
  } catch (error) {
    console.error("❌ Failed to start WebSocket connection:", error);
    console.error("Error details:", error.message);
    console.error("Stack:", error.stack);
    console.log("Retrying in 10 seconds...");
    setTimeout(() => {
      console.log("Retrying connection...");
      connectKalshiWebSocket().catch((err) => {
        console.error("Retry failed:", err);
      });
    }, 10000);
  }
})();

// Keep the process alive and handle shutdown gracefully
try {
  if (typeof Deno !== "undefined" && typeof Deno.addSignalListener === "function") {
    Deno.addSignalListener("SIGINT", () => {
      console.log("\n👋 Shutting down...");
      Deno.exit(0);
    });
    
    Deno.addSignalListener("SIGTERM", () => {
      console.log("\n👋 Shutting down...");
      Deno.exit(0);
    });
  }
} catch (e) {
  // Signal listeners not available in this environment
  console.log("Signal listeners not available, continuing...");
}

// Keep process alive with a heartbeat
setInterval(() => {
  // Heartbeat to keep process alive
  console.log("💓 Service heartbeat");
}, 60000);

