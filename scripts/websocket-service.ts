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

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase credentials");
  Deno.exit(1);
}

if (!KALSHI_API_KEY_ID || !KALSHI_PRIVATE_KEY) {
  console.error("Missing Kalshi credentials");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");

  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function connectKalshiWebSocket() {
  const timestamp = Date.now().toString();
  const path = "/trade-api/ws/v2";
  const message = timestamp + "GET" + path;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(KALSHI_PRIVATE_KEY!),
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"]
  );

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

  ws.onclose = () => {
    console.log("⚠️ WebSocket closed, reconnecting in 5 seconds...");
    setTimeout(() => connectKalshiWebSocket(), 5000);
  };

  return ws;
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
connectKalshiWebSocket();

// Keep the process alive
Deno.addSignalListener("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  Deno.exit(0);
});

