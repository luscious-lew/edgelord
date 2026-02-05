/**
 * Manual Trade Trigger
 *
 * Usage: deno run --allow-net --allow-env scripts/trade-now.ts "James Harden"
 *
 * You watch Twitter, when you see a trade confirmed, run this with the player name.
 * Bot will instantly find the market and place a YES order.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const KALSHI_API_KEY_ID = Deno.env.get("KALSHI_API_KEY_ID") ?? "";
const KALSHI_PRIVATE_KEY = Deno.env.get("KALSHI_PRIVATE_KEY") ?? "";

const CONTRACT_COUNT = Number(Deno.env.get("TRADE_CONTRACT_COUNT") ?? "100");
const MAX_YES_PRICE_CENTS = Number(Deno.env.get("TRADE_MAX_YES_PRICE") ?? "95");
const PRICE_SLIPPAGE_CENTS = Number(Deno.env.get("TRADE_SLIPPAGE") ?? "3");

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =============================================================================
// KALSHI AUTH
// =============================================================================

function pemToArrayBuffer(pem: string): ArrayBuffer {
  let normalized = pem.replace(/\s+/g, "");
  if (normalized.includes("BEGINPRIVATEKEY")) {
    normalized = normalized.replace("-----BEGINPRIVATEKEY-----", "").replace("-----ENDPRIVATEKEY-----", "");
  } else if (pem.includes("BEGIN PRIVATE KEY")) {
    normalized = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getKalshiHeaders(method: string, path: string): Promise<Headers> {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path;
  const keyBuffer = pemToArrayBuffer(KALSHI_PRIVATE_KEY);
  const privateKey = await crypto.subtle.importKey("pkcs8", keyBuffer, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, privateKey, new TextEncoder().encode(message));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

  const headers = new Headers();
  headers.set("KALSHI-ACCESS-KEY", KALSHI_API_KEY_ID);
  headers.set("KALSHI-ACCESS-TIMESTAMP", timestamp);
  headers.set("KALSHI-ACCESS-SIGNATURE", signatureB64);
  headers.set("Content-Type", "application/json");
  return headers;
}

// =============================================================================
// MARKET LOOKUP
// =============================================================================

type Market = {
  id: string;
  ticker: string;
  title: string;
  player_name: string;
  yes_price: number | null;
};

function extractPlayerName(title: string): string | null {
  const match = title.match(/will\s+(.+?)\s+be\s+traded/i);
  if (match) return match[1].trim();
  const match2 = title.match(/^(.+?)\s+traded\s+before/i);
  if (match2) return match2[1].trim();
  return null;
}

async function findMarket(playerName: string): Promise<Market | null> {
  console.log(`🔍 Searching for market: "${playerName}"...`);

  const { data, error } = await supabase
    .from("markets")
    .select("id, venue_market_ticker, title, yes_price_last")
    .eq("venue", "kalshi")
    .like("venue_market_ticker", "KXNBATRADE%")
    .neq("status", "settled");

  if (error) {
    console.error("Database error:", error);
    return null;
  }

  const markets = (data ?? []).map(m => ({
    id: m.id,
    ticker: m.venue_market_ticker,
    title: m.title,
    player_name: extractPlayerName(m.title) ?? "",
    yes_price: m.yes_price_last,
  })).filter(m => m.player_name);

  console.log(`📊 Found ${markets.length} NBA trade markets`);

  const searchLower = playerName.toLowerCase();

  // Exact match
  for (const m of markets) {
    if (m.player_name.toLowerCase() === searchLower) {
      console.log(`✅ Exact match: ${m.player_name} → ${m.ticker}`);
      return m;
    }
  }

  // Partial match (last name)
  for (const m of markets) {
    const marketLast = m.player_name.split(" ").pop()?.toLowerCase() ?? "";
    const searchLast = searchLower.split(" ").pop() ?? "";
    if (marketLast.length >= 4 && marketLast === searchLast) {
      console.log(`✅ Last name match: ${m.player_name} → ${m.ticker}`);
      return m;
    }
  }

  // Fuzzy match (contains)
  for (const m of markets) {
    if (m.player_name.toLowerCase().includes(searchLower) || searchLower.includes(m.player_name.toLowerCase())) {
      console.log(`✅ Fuzzy match: ${m.player_name} → ${m.ticker}`);
      return m;
    }
  }

  console.log(`❌ No market found for "${playerName}"`);
  console.log("Available markets:");
  markets.forEach(m => console.log(`  - ${m.player_name}`));
  return null;
}

// =============================================================================
// ORDER EXECUTION
// =============================================================================

async function getOrderbook(ticker: string): Promise<{ yes_ask: number | null }> {
  const path = `/trade-api/v2/markets/${ticker}/orderbook`;
  const headers = await getKalshiHeaders("GET", path);

  try {
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });
    if (!response.ok) return { yes_ask: null };

    const data = await response.json();
    if (data.orderbook?.no?.length > 0) {
      const noBid = data.orderbook.no[0][0];
      return { yes_ask: 100 - noBid };
    }
  } catch (e) {
    console.error("Orderbook error:", e);
  }
  return { yes_ask: null };
}

async function placeOrder(market: Market): Promise<boolean> {
  console.log(`\n💰 Placing order for ${market.player_name}...`);

  // Get orderbook
  const { yes_ask } = await getOrderbook(market.ticker);
  console.log(`📈 Current YES ask: ${yes_ask ?? "unknown"}c`);

  // Calculate price
  let price: number;
  if (yes_ask !== null) {
    price = Math.min(yes_ask + PRICE_SLIPPAGE_CENTS, MAX_YES_PRICE_CENTS);
  } else if (market.yes_price !== null) {
    price = Math.min(Math.round(market.yes_price * 100) + PRICE_SLIPPAGE_CENTS, MAX_YES_PRICE_CENTS);
  } else {
    price = 50 + PRICE_SLIPPAGE_CENTS;
  }

  console.log(`🎯 Order: ${CONTRACT_COUNT} YES @ ${price}c`);
  console.log(`💵 Max cost: $${(CONTRACT_COUNT * price / 100).toFixed(2)}`);

  const order = {
    ticker: market.ticker,
    side: "yes",
    action: "buy",
    type: "limit",
    count: CONTRACT_COUNT,
    yes_price: price,
    client_order_id: `manual-${Date.now()}`,
  };

  const path = "/trade-api/v2/portfolio/orders";
  const headers = await getKalshiHeaders("POST", path);

  try {
    const response = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify(order),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(`❌ Order failed: ${response.status}`);
      console.error(JSON.stringify(result, null, 2));
      return false;
    }

    console.log(`\n✅ ORDER PLACED!`);
    console.log(`   Order ID: ${result.order.order_id}`);
    console.log(`   Status: ${result.order.status}`);
    console.log(`   Ticker: ${market.ticker}`);

    // Record in database
    await supabase.from("trades").insert({
      market_ticker: market.ticker,
      order_id: result.order.order_id,
      side: "yes",
      action: "buy",
      price_cents: price,
      contract_count: CONTRACT_COUNT,
      status: result.order.status,
      meta: { player_name: market.player_name, manual: true },
    });

    return true;
  } catch (e) {
    console.error("Order exception:", e);
    return false;
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const playerName = Deno.args[0];

  if (!playerName) {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           NBA TRADE DEADLINE - MANUAL TRIGGER              ║
╠════════════════════════════════════════════════════════════╣
║  Usage:                                                    ║
║    ./trade-player.sh "James Harden"                        ║
║    ./trade-player.sh "Giannis"                             ║
║                                                            ║
║  What it does:                                             ║
║    1. Finds the Kalshi market for that player              ║
║    2. Places a YES limit order immediately                 ║
║                                                            ║
║  Config:                                                   ║
║    Contracts: ${CONTRACT_COUNT.toString().padEnd(5)}                                       ║
║    Max price: ${MAX_YES_PRICE_CENTS}c                                          ║
║    Slippage:  ${PRICE_SLIPPAGE_CENTS}c                                           ║
╚════════════════════════════════════════════════════════════╝
`);
    Deno.exit(1);
  }

  console.log(`\n🏀 NBA TRADE - MANUAL TRIGGER`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Player: ${playerName}`);
  console.log(`Contracts: ${CONTRACT_COUNT}`);
  console.log(`Max price: ${MAX_YES_PRICE_CENTS}c\n`);

  const market = await findMarket(playerName);

  if (!market) {
    console.log(`\n❌ Could not find market for "${playerName}"`);
    Deno.exit(1);
  }

  const success = await placeOrder(market);

  if (success) {
    console.log(`\n🎉 Trade executed successfully!`);
  } else {
    console.log(`\n❌ Trade failed`);
    Deno.exit(1);
  }
}

main();
