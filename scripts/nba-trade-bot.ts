/**
 * NBA Trade Deadline Real-Time Bot
 *
 * A persistent service that:
 * 1. Streams tweets from trusted NBA insiders in real-time
 * 2. Detects confirmed trades via keyword matching
 * 3. Matches player names to Kalshi markets
 * 4. Instantly places YES orders on matched markets
 *
 * Designed for maximum speed - the trade deadline is a race!
 *
 * Run with: deno run --allow-net --allow-env scripts/nba-trade-bot.ts
 */

import { createClient } from "npm:@supabase/supabase-js@2";

// =============================================================================
// CONFIGURATION
// =============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWITTER_BEARER_TOKEN = Deno.env.get("TWITTER_BEARER_TOKEN") ?? "";
const KALSHI_API_KEY_ID = Deno.env.get("KALSHI_API_KEY_ID") ?? "";
const KALSHI_PRIVATE_KEY = Deno.env.get("KALSHI_PRIVATE_KEY") ?? "";

// Trading configuration
const CONTRACT_COUNT = Number(Deno.env.get("TRADE_CONTRACT_COUNT") ?? "100");
const MAX_YES_PRICE_CENTS = Number(Deno.env.get("TRADE_MAX_YES_PRICE") ?? "95");
const PRICE_SLIPPAGE_CENTS = Number(Deno.env.get("TRADE_SLIPPAGE") ?? "3");

// Polling interval for Twitter API (in milliseconds)
// Basic tier: 15,000 reads/month - need to conserve
// 30 sec = 2,880/day = ~5 days continuous
// Reduce to 15 sec closer to deadline
const POLL_INTERVAL_MS = Number(Deno.env.get("POLL_INTERVAL_MS") ?? "30000"); // 30 seconds default

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// Trusted NBA insiders (handle -> user ID)
// Ordered by speed/reliability for breaking trades
const TRUSTED_SOURCES: Record<string, string> = {
  "ShamsCharania": "178580925",    // The Athletic - fastest for NBA trades
  "ChrisBHaynes": "57710919",      // TNT/Bleacher Report
  "TheSteinLine": "48488561",      // Marc Stein - independent
  "WindhorstESPN": "193095044",    // ESPN - Brian Windhorst
  "TimBontemps": "50721809",       // ESPN
};

// Trade confirmation patterns - extract player names
const TRADE_PATTERNS = [
  /trading\s+(?:center\s+|forward\s+|guard\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
  /([A-Z][a-z]+\s+[A-Z][a-z]+)\s+(?:has been|is being|will be)\s+traded/i,
  /(?:acquiring|acquired)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
  /sends?\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)\s+(?:to|and)/i,
  /deal\s+(?:that\s+)?sends?\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
  /landing\s+(?:.*?\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)/i,
  /([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)\s+(?:traded|dealt)\s+to/i,
];

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =============================================================================
// KALSHI AUTHENTICATION
// =============================================================================

function pemToArrayBuffer(pem: string): ArrayBuffer {
  let normalizedPem = pem.replace(/\s+/g, "");

  if (normalizedPem.includes("BEGINPRIVATEKEY")) {
    normalizedPem = normalizedPem
      .replace("-----BEGINPRIVATEKEY-----", "")
      .replace("-----ENDPRIVATEKEY-----", "");
  } else if (pem.includes("BEGIN PRIVATE KEY")) {
    normalizedPem = pem
      .replace(/-----BEGIN PRIVATE KEY-----/g, "")
      .replace(/-----END PRIVATE KEY-----/g, "")
      .replace(/\s/g, "");
  }

  const binaryString = atob(normalizedPem);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getKalshiAuthHeaders(
  method: string,
  path: string
): Promise<Headers> {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path;

  const keyBuffer = pemToArrayBuffer(KALSHI_PRIVATE_KEY);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
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

  const headers = new Headers();
  headers.set("KALSHI-ACCESS-KEY", KALSHI_API_KEY_ID);
  headers.set("KALSHI-ACCESS-TIMESTAMP", timestamp);
  headers.set("KALSHI-ACCESS-SIGNATURE", signatureB64);
  headers.set("Content-Type", "application/json");

  return headers;
}

// =============================================================================
// MARKET CACHE
// =============================================================================

type MarketInfo = {
  id: string;
  ticker: string;
  player_name: string;
  yes_price: number | null;
};

let marketCache: MarketInfo[] = [];
let lastMarketRefresh = 0;
const MARKET_CACHE_TTL_MS = 60000; // Refresh every minute

function extractPlayerName(title: string): string | null {
  const match = title.match(/will\s+(.+?)\s+be\s+traded/i);
  if (match) return match[1].trim();

  const match2 = title.match(/^(.+?)\s+traded\s+before/i);
  if (match2) return match2[1].trim();

  return null;
}

async function refreshMarketCache(): Promise<void> {
  const now = Date.now();
  if (now - lastMarketRefresh < MARKET_CACHE_TTL_MS && marketCache.length > 0) {
    return;
  }

  console.log("[CACHE] Refreshing NBA trade markets...");

  const { data, error } = await supabase
    .from("markets")
    .select("id, venue_market_ticker, title, yes_price_last")
    .eq("venue", "kalshi")
    .like("venue_market_ticker", "KXNBATRADE%")
    .neq("status", "settled");

  if (error) {
    console.error("[CACHE] Error fetching markets:", error);
    return;
  }

  marketCache = (data ?? [])
    .map((m) => ({
      id: m.id,
      ticker: m.venue_market_ticker,
      player_name: extractPlayerName(m.title) ?? "",
      yes_price: m.yes_price_last,
    }))
    .filter((m) => m.player_name);

  lastMarketRefresh = now;
  console.log(`[CACHE] Loaded ${marketCache.length} NBA trade markets`);
  marketCache.forEach((m) => console.log(`  - ${m.player_name}: ${m.ticker}`));
}

function findMarketForPlayer(playerName: string): MarketInfo | null {
  const searchName = playerName.toLowerCase();

  // Try exact match first
  for (const market of marketCache) {
    if (market.player_name.toLowerCase() === searchName) {
      return market;
    }
  }

  // Try partial match (last name)
  for (const market of marketCache) {
    const marketLastName = market.player_name.split(" ").pop()?.toLowerCase();
    const searchLastName = searchName.split(" ").pop();

    if (
      marketLastName &&
      searchLastName &&
      marketLastName.length >= 4 &&
      marketLastName === searchLastName
    ) {
      return market;
    }
  }

  return null;
}

// =============================================================================
// TWEET PROCESSING
// =============================================================================

type Tweet = {
  id: string;
  text: string;
  author: string;
  created_at: string;
};

const processedTweets = new Set<string>();

function extractPlayersFromTweet(text: string): string[] {
  const players: string[] = [];

  for (const pattern of TRADE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const player = match[1].trim();
      // Filter out common false positives
      if (!["The Bulls", "The Lakers", "The Jazz", "Pro Basketball", "NBA Today"].includes(player)) {
        players.push(player);
      }
    }
  }

  // Also try to find multiple players in multi-team deals
  const multiPattern = /sends?\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)\s+and\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)/gi;
  let multiMatch;
  while ((multiMatch = multiPattern.exec(text)) !== null) {
    if (multiMatch[1]) players.push(multiMatch[1].trim());
    if (multiMatch[2]) players.push(multiMatch[2].trim());
  }

  // Deduplicate
  return [...new Set(players)];
}

function isTradeConfirmation(text: string): boolean {
  const lowerText = text.toLowerCase();
  const confirmationPhrases = [
    "trading",
    "traded to",
    "has been traded",
    "is being traded",
    "trade is done",
    "trade complete",
    "acquiring",
    "acquired",
    "finalizing",
    "deal that sends",
    "agreed to",
    "sources:",
    "sources tell",
    "per sources",
    "just in:",
    "breaking:",
    "landing",
    "dealt to",
  ];

  return confirmationPhrases.some((phrase) => lowerText.includes(phrase));
}

// =============================================================================
// ORDER EXECUTION
// =============================================================================

async function getOrderbook(
  ticker: string
): Promise<{ yes_ask: number | null }> {
  const path = `/trade-api/v2/markets/${ticker}/orderbook`;
  const headers = await getKalshiAuthHeaders("GET", path);

  try {
    const response = await fetch(
      `${KALSHI_BASE.replace("/trade-api/v2", "")}/trade-api/v2/markets/${ticker}/orderbook`,
      { headers }
    );

    if (!response.ok) {
      console.error(`[ORDERBOOK] Error for ${ticker}: ${response.status}`);
      return { yes_ask: null };
    }

    const data = await response.json();

    if (data.orderbook?.no?.length > 0) {
      const noBid = data.orderbook.no[0][0];
      return { yes_ask: 100 - noBid };
    }
  } catch (e) {
    console.error(`[ORDERBOOK] Exception for ${ticker}:`, e);
  }

  return { yes_ask: null };
}

async function placeYesOrder(
  market: MarketInfo,
  tweet: Tweet
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  console.log(`[ORDER] Placing YES order for ${market.player_name}...`);

  // Get current orderbook
  const { yes_ask } = await getOrderbook(market.ticker);

  // Determine price
  let price: number;
  if (yes_ask !== null) {
    price = Math.min(yes_ask + PRICE_SLIPPAGE_CENTS, MAX_YES_PRICE_CENTS);
  } else if (market.yes_price !== null) {
    price = Math.min(
      Math.round(market.yes_price * 100) + PRICE_SLIPPAGE_CENTS,
      MAX_YES_PRICE_CENTS
    );
  } else {
    price = 50 + PRICE_SLIPPAGE_CENTS;
  }

  console.log(`[ORDER] ${market.ticker}: ${CONTRACT_COUNT} YES @ ${price}c`);

  const order = {
    ticker: market.ticker,
    side: "yes",
    action: "buy",
    type: "limit",
    count: CONTRACT_COUNT,
    yes_price: price,
    client_order_id: `nba-trade-${tweet.id}-${Date.now()}`,
  };

  const path = "/trade-api/v2/portfolio/orders";
  const headers = await getKalshiAuthHeaders("POST", path);

  try {
    const response = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify(order),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ORDER] Failed: ${response.status} - ${errorText}`);
      return { success: false, error: errorText };
    }

    const result = await response.json();
    console.log(
      `[ORDER] ✅ SUCCESS! Order ID: ${result.order.order_id}, Status: ${result.order.status}`
    );

    // Record trade in database
    await supabase.from("trades").insert({
      market_ticker: market.ticker,
      order_id: result.order.order_id,
      side: "yes",
      action: "buy",
      price_cents: price,
      contract_count: CONTRACT_COUNT,
      status: result.order.status,
      meta: {
        tweet_id: tweet.id,
        tweet_author: tweet.author,
        player_name: market.player_name,
      },
    });

    return { success: true, orderId: result.order.order_id };
  } catch (e) {
    console.error(`[ORDER] Exception:`, e);
    return { success: false, error: String(e) };
  }
}

// =============================================================================
// TWITTER POLLING (using user timeline endpoint)
// =============================================================================

// Track last tweet ID per user to avoid duplicates
const lastTweetIds: Record<string, string> = {};

async function pollTwitter(): Promise<Tweet[]> {
  const allTweets: Tweet[] = [];

  for (const [handle, userId] of Object.entries(TRUSTED_SOURCES)) {
    try {
      const url = new URL(`https://api.twitter.com/2/users/${userId}/tweets`);
      url.searchParams.set("max_results", "5");
      url.searchParams.set("tweet.fields", "created_at,text");

      if (lastTweetIds[userId]) {
        url.searchParams.set("since_id", lastTweetIds[userId]);
      }

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.log(`[TWITTER] Rate limited on @${handle}, waiting...`);
          continue;
        }
        console.error(`[TWITTER] Error fetching @${handle}: ${response.status}`);
        continue;
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        continue;
      }

      // Update newest tweet ID for this user
      if (data.meta?.newest_id) {
        lastTweetIds[userId] = data.meta.newest_id;
      }

      for (const t of data.data) {
        allTweets.push({
          id: t.id,
          text: t.text,
          author: handle,
          created_at: t.created_at,
        });
      }
    } catch (e) {
      console.error(`[TWITTER] Exception for @${handle}:`, e);
    }
  }

  return allTweets;
}

// =============================================================================
// MAIN LOOP
// =============================================================================

async function processTweet(tweet: Tweet): Promise<void> {
  if (processedTweets.has(tweet.id)) {
    return;
  }
  processedTweets.add(tweet.id);

  console.log(`\n[TWEET] @${tweet.author}: ${tweet.text.substring(0, 100)}...`);

  // Check if it's a trade confirmation
  if (!isTradeConfirmation(tweet.text)) {
    console.log("[TWEET] Not a trade confirmation, skipping");
    return;
  }

  // Extract player names from tweet
  const players = extractPlayersFromTweet(tweet.text);
  if (players.length === 0) {
    console.log("[TWEET] Could not extract player names");
    return;
  }

  console.log(`[TWEET] Detected players: ${players.join(", ")}`);

  // Find matching markets and execute trades
  for (const playerName of players) {
    const market = findMarketForPlayer(playerName);
    if (!market) {
      console.log(`[TWEET] No market found for: ${playerName}`);
      continue;
    }

    console.log(`[TWEET] ⚡ MATCH! ${market.player_name} -> ${market.ticker}`);

    // Execute trade!
    const result = await placeYesOrder(market, tweet);

    if (result.success) {
      console.log(`[TRADE] ✅ Order placed: ${result.orderId}`);
    } else {
      console.log(`[TRADE] ❌ Order failed: ${result.error}`);
    }
  }
}

async function runBot(): Promise<void> {
  console.log("=".repeat(60));
  console.log(" NBA TRADE DEADLINE BOT - REAL-TIME TRADING");
  console.log("=".repeat(60));
  console.log(`Monitoring: ${Object.keys(TRUSTED_SOURCES).join(", ")}`);
  console.log(`Position size: ${CONTRACT_COUNT} contracts`);
  console.log(`Max YES price: ${MAX_YES_PRICE_CENTS}c`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log("=".repeat(60));

  // Initial market cache load
  await refreshMarketCache();

  console.log("\n[BOT] Starting real-time monitoring...\n");

  // Main polling loop
  while (true) {
    try {
      // Refresh market cache periodically
      await refreshMarketCache();

      // Poll for new tweets
      const tweets = await pollTwitter();

      if (tweets.length > 0) {
        console.log(`[TWITTER] Found ${tweets.length} new tweets`);
        for (const tweet of tweets) {
          await processTweet(tweet);
        }
      }
    } catch (e) {
      console.error("[BOT] Error in main loop:", e);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Run the bot
runBot().catch(console.error);
