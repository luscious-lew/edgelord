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
import WebSocket from "npm:ws@8.18.0";

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
    // According to Kalshi docs: timestamp + method + path.split('?')[0]
    // Python example: timestamp + "GET" + "/trade-api/ws/v2"
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/trade-api/ws/v2";
    const message = timestamp + method + path;

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

    // According to Kalshi WebSocket docs, authentication must be in HEADERS, not query params
    // https://docs.kalshi.com/getting_started/quick_start_websockets
    // Python example uses: websockets.connect(WS_URL, additional_headers=ws_headers)
    // We'll use the ws library which supports headers via options.headers
    const headers: Record<string, string> = {
      "KALSHI-ACCESS-KEY": KALSHI_API_KEY_ID!,
      "KALSHI-ACCESS-SIGNATURE": signatureB64,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    };

    console.log("Connecting to Kalshi WebSocket with headers...");
    console.log("Signature length:", signatureB64.length);
    console.log("Headers:", Object.keys(headers));
    
    // Use ws library from npm which supports custom headers via options
    // The npm: specifier ensures proper Node.js compatibility in Deno
    const ws = new WebSocket(KALSHI_WS_URL, {
      headers: headers,
    });

    ws.on("open", () => {
      console.log("✅ Connected to Kalshi WebSocket");
      // According to Kalshi docs, subscription format is:
      // { "id": 1, "cmd": "subscribe", "params": { "channels": ["ticker"] } }
      ws.send(JSON.stringify({
        id: 1,
        cmd: "subscribe",
        params: {
          channels: ["ticker"], // Subscribe to ticker updates for all markets
        },
      }));
      console.log("📤 Sent subscription request");
    });

    ws.on("message", async (data: Buffer | string) => {
      try {
        const messageStr = typeof data === "string" ? data : data.toString();
        const message = JSON.parse(messageStr);
        
        // Log full message structure for debugging
        console.log("📨 Received message:", JSON.stringify(message).substring(0, 300));
        
        // Kalshi messages have a "type" field indicating the message type
        // Message types include: "subscribed", "ticker", "orderbook_snapshot", "orderbook_delta", "trades", "error"
        const msgType = message.type;
        console.log("📨 Message type:", msgType);

        // Handle subscription confirmation
        if (msgType === "subscribed") {
          console.log("✅ Successfully subscribed:", message);
          return;
        }

        // Handle ticker updates (real-time price updates)
        // Message type is "ticker", and the data contains "market_ticker" field
        if (msgType === "ticker") {
          await handleMarketUpdate(message);
        }
        // Handle orderbook updates
        else if (msgType === "orderbook_snapshot" || msgType === "orderbook_delta") {
          await handleOrderbookUpdate(message);
        }
        // Handle trade updates
        else if (msgType === "trades") {
          await handleMarketUpdate(message);
        }
        // Handle errors
        else if (msgType === "error") {
          const errorCode = message.msg?.code;
          const errorMsg = message.msg?.msg;
          console.error(`❌ WebSocket error ${errorCode}: ${errorMsg}`);
        }
        // Log unknown message types
        else {
          console.log("📨 Unknown message type:", msgType, "Full message:", JSON.stringify(message).substring(0, 500));
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    });

    ws.on("error", (error: Error) => {
      console.error("❌ WebSocket error:", error.message);
      console.error("Error stack:", error.stack);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason ? reason.toString() : "none";
      console.log(`⚠️ WebSocket closed (code: ${code}, reason: ${reasonStr}), reconnecting in 5 seconds...`);
      if (code !== 1000 && code !== 1001) {
        console.error(`Connection closed abnormally. Code: ${code}, Reason: ${reasonStr}`);
      }
      setTimeout(() => {
        connectKalshiWebSocket().catch((err) => {
          console.error("Failed to reconnect:", err);
        });
      }, 5000);
    });

    return ws;
  } catch (error) {
    console.error("❌ Error connecting to WebSocket:", error);
    throw error;
  }
}

async function handleMarketUpdate(message: any) {
  // Kalshi WebSocket message format:
  // - Message type: "ticker" (checked in the message handler above)
  // - Message structure: { "type": "ticker", "sid": 1, "msg": { "market_ticker": "...", "yes_bid": ..., "yes_ask": ... } }
  // - The actual data is in message.msg (not message.data)
  // - The field name within msg is "market_ticker" (not "ticker")
  const data = message.msg || message.data || message;
  const ticker = data.market_ticker; // Extract "market_ticker" field from the data (not the message type)
  
  if (!ticker) {
    console.warn("No market_ticker found in message data:", JSON.stringify(message).substring(0, 300));
    return;
  }

  // Kalshi ticker message has yes_bid, yes_ask, no_bid, no_ask, price_dollars
  // price_dollars is the last trade price (0-1 range)
  // yes_bid/yes_ask and no_bid/no_ask are in cents (0-100 range)
  const update: any = {
    yes_price_last: data.yes_ask ? data.yes_ask / 100 : (data.price_dollars ? parseFloat(data.price_dollars) : null),
    no_price_last: data.no_ask ? data.no_ask / 100 : (data.price_dollars ? 1 - parseFloat(data.price_dollars) : null),
    volume: data.dollar_volume || data.volume,
    status: data.status || "open",
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
    console.log(`✅ Updated ${ticker} - yes: ${update.yes_price_last}, no: ${update.no_price_last}`);
  }
}

async function handleOrderbookUpdate(message: any) {
  // Kalshi orderbook message structure: { "type": "orderbook_snapshot", "msg": { "market_ticker": "...", ... } }
  const data = message.msg || message.data || message;
  const ticker = data.market_ticker; // Kalshi uses "market_ticker"
  if (!ticker) {
    console.warn("No market_ticker found in orderbook message:", JSON.stringify(message).substring(0, 300));
    return;
  }

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
    const err = error as Error;
    console.error("Error details:", err.message);
    console.error("Stack:", err.stack);
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

