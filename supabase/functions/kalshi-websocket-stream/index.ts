import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { supabase } from "../_shared/supabaseClient.ts";
import { getKalshiAuthHeaders } from "../_shared/kalshiAuth.ts";

const KALSHI_WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2";
// For demo: wss://demo-api.kalshi.co/trade-api/ws/v2

type WebSocketMessage = {
  type: string;
  [key: string]: any;
};

type MarketUpdate = {
  ticker: string;
  yes_price?: number;
  no_price?: number;
  volume?: number;
  status?: string;
};

/**
 * Connects to Kalshi WebSocket and streams real-time market updates
 * This function maintains a persistent connection and updates Supabase in real-time
 */
async function connectKalshiWebSocket() {
  // Get authentication headers for WebSocket connection
  const timestamp = Date.now().toString();
  const path = "/trade-api/ws/v2";
  const message = timestamp + "GET" + path;
  
  // We need to sign the message for WebSocket authentication
  const apiKeyId = Deno.env.get("KALSHI_API_KEY_ID");
  const privateKeyPem = Deno.env.get("KALSHI_PRIVATE_KEY");

  if (!apiKeyId || !privateKeyPem) {
    throw new Error("Missing Kalshi API credentials");
  }

  // Import private key and sign
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
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

  // Connect to WebSocket with authentication headers
  const wsUrl = `${KALSHI_WS_URL}?KALSHI-ACCESS-KEY=${apiKeyId}&KALSHI-ACCESS-TIMESTAMP=${timestamp}&KALSHI-ACCESS-SIGNATURE=${signatureB64}`;
  
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected to Kalshi WebSocket");
    
    // Subscribe to market updates
    // You can subscribe to specific markets or all markets
    ws.send(JSON.stringify({
      type: "subscribe",
      channels: ["market_data"], // Adjust based on Kalshi's available channels
    }));
  };

  ws.onmessage = async (event) => {
    try {
      const message: WebSocketMessage = JSON.parse(event.data);
      
      if (message.type === "market_update" || message.type === "trade") {
        await handleMarketUpdate(message);
      } else if (message.type === "orderbook_update") {
        await handleOrderbookUpdate(message);
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
  };

  ws.onclose = () => {
    console.log("WebSocket closed, reconnecting in 5 seconds...");
    setTimeout(() => connectKalshiWebSocket(), 5000);
  };

  return ws;
}

async function handleMarketUpdate(message: WebSocketMessage) {
  const update: MarketUpdate = {
    ticker: message.ticker || message.market_ticker,
    yes_price: message.yes_price,
    no_price: message.no_price,
    volume: message.volume,
    status: message.status,
  };

  if (!update.ticker) return;

  // Update market in Supabase
  const { error } = await supabase
    .from("markets")
    .update({
      yes_price_last: update.yes_price,
      no_price_last: update.no_price,
      volume: update.volume,
      status: update.status,
      updated_at: new Date().toISOString(),
    })
    .eq("venue", "kalshi")
    .eq("venue_market_ticker", update.ticker);

  if (error) {
    console.error(`Error updating market ${update.ticker}:`, error);
  } else {
    console.log(`Updated market ${update.ticker}`);
  }
}

async function handleOrderbookUpdate(message: WebSocketMessage) {
  const ticker = message.ticker || message.market_ticker;
  if (!ticker) return;

  // Get market ID
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

  // Insert orderbook snapshot
  const { error } = await supabase.from("market_quotes").insert({
    market_id: market.id,
    yes_best_bid: yesPrice,
    yes_best_bid_qty: yesQty,
    no_best_bid: noPrice,
    no_best_bid_qty: noQty,
    yes_price_last: message.yes_price,
    no_price_last: message.no_price,
    orderbook_raw: orderbook,
  });

  if (error) {
    console.error(`Error inserting orderbook for ${ticker}:`, error);
  }
}

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

/**
 * Edge Function handler
 * Note: Edge Functions have execution time limits, so for a persistent WebSocket
 * connection, you may want to run this as a separate service or use Supabase's
 * background workers feature when available.
 */
serve(async (_req) => {
  try {
    // For now, this will start the WebSocket connection
    // In production, you might want this running as a separate service
    const ws = await connectKalshiWebSocket();
    
    return new Response(
      JSON.stringify({ 
        ok: true, 
        message: "WebSocket connection started",
        note: "This function maintains a persistent connection. Consider running as a separate service for production."
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error(error);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" } 
      }
    );
  }
});

