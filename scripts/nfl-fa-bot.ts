// =============================================================================
// NFL FREE AGENCY BOT - Monitor & Trade NFL Free Agency Markets
// =============================================================================
// Monitors NFL insider Twitter accounts for trade/signing/release news,
// classifies signals via LLM, and trades Kalshi NFL markets.
//
// Run with: deno run --allow-net --allow-env scripts/nfl-fa-bot.ts
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// =============================================================================
// CONFIGURATION
// =============================================================================

const KALSHI_API_KEY_ID = Deno.env.get("KALSHI_API_KEY_ID") ?? "";
const KALSHI_PRIVATE_KEY = Deno.env.get("KALSHI_PRIVATE_KEY") ?? "";
const TWITTER_BEARER_TOKEN = Deno.env.get("TWITTER_BEARER_TOKEN") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const BOT_ID = "nfl-fa-bot";
const NFL_TRADING_DISABLED = false; // Trading enabled

// Sizing
const MAX_SPEND_PER_TRADE_CENTS = 2500;
const MIN_CONTRACTS = 5;
const MAX_CONTRACTS = 100;

// Timing
const MARKET_REFRESH_MS = 30_000;
const DEEP_ANALYSIS_INTERVAL_MS = 5 * 60 * 1000;
const STATE_SAVE_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

// Rate limiting for LLM calls
let lastLlmCallMs = 0;

// =============================================================================
// CONFIDENCE CONFIG
// =============================================================================

const CONFIDENCE_CONFIG = {
  confirmed:    { maxPrice: 95, sizeMultiplier: 1.0 },
  strong_intel: { maxPrice: 80, sizeMultiplier: 0.7 },
  developing:   { maxPrice: 55, sizeMultiplier: 0.4 },
  speculation:  { maxPrice: 0,  sizeMultiplier: 0 },
} as const;

// =============================================================================
// REGEX FAST-PATH PATTERNS
// =============================================================================
// These run in parallel with LLM — if regex matches, we get a head start on
// signal processing while LLM provides the full classification.

const FAST_PATH_PATTERNS: { pattern: RegExp; eventType: string; tier: string }[] = [
  { pattern: /has been traded to the (.+)/i, eventType: "trade", tier: "confirmed" },
  { pattern: /is being traded to the (.+)/i, eventType: "trade", tier: "confirmed" },
  { pattern: /trading .+ to the (.+)/i, eventType: "trade", tier: "confirmed" },
  { pattern: /has agreed to .+ deal with the (.+)/i, eventType: "signing", tier: "confirmed" },
  { pattern: /is signing .+ deal with the (.+)/i, eventType: "signing", tier: "confirmed" },
  { pattern: /has been released/i, eventType: "release", tier: "confirmed" },
  { pattern: /has been cut/i, eventType: "cut", tier: "confirmed" },
  { pattern: /is signing.+extension/i, eventType: "extension", tier: "confirmed" },
];

// =============================================================================
// TWITTER SOURCES (Tiered by reliability & speed)
// =============================================================================
// userIds are resolved at runtime via Twitter API lookup

const TWITTER_SOURCES: { handle: string; userId: string; tier: number }[] = [
  // Tier 1 — fastest, most reliable NFL insiders (poll every 3s)
  { handle: "AdamSchefter",  userId: "", tier: 1 },
  { handle: "RapSheet",      userId: "", tier: 1 },
  { handle: "TomPelissero",  userId: "", tier: 1 },
  { handle: "JayGlazer",     userId: "", tier: 1 },

  // Tier 2 — reliable but slightly slower (poll every 15s)
  { handle: "JosinaAnderson", userId: "", tier: 2 },
  { handle: "AlbertBreer",    userId: "", tier: 2 },
  { handle: "JordanSchultz",  userId: "", tier: 2 },
  { handle: "MikeGarafolo",   userId: "", tier: 2 },
  { handle: "DiannaBESPN",    userId: "", tier: 2 },
  { handle: "FieldYates",     userId: "", tier: 2 },

  // Tier 3 — official accounts (poll every 60s)
  { handle: "NFL", userId: "", tier: 3 },
];

const TIER_POLL_MS: Record<number, number> = {
  1: 3_000,
  2: 15_000,
  3: 60_000,
};

// =============================================================================
// TYPES
// =============================================================================

type ConfidenceTier = "confirmed" | "strong_intel" | "developing" | "speculation";
type EventType = "trade" | "signing" | "cut" | "release" | "extension" | "rumor" | "cap_move";
type MarketType = "nfltrade" | "nextteam";
type Sentiment = "rising" | "stable" | "falling" | "volatile";

interface NFLMarket {
  ticker: string;
  title: string;
  subtitle: string;
  playerName: string;
  teamName: string | null; // For nextteam markets
  marketType: MarketType;
  yesPrice: number;       // 0-100 cents
  noPrice: number;        // 0-100 cents
  volume: number;
  openInterest: number;
  seriesTicker: string;
  status: string;
}

interface PlayerMap {
  playerName: string;
  tradeMarket: NFLMarket | null;              // "Will X be traded?" market
  nextTeamMarkets: Map<string, NFLMarket>;    // team -> market mapping
}

interface Signal {
  id: string;
  tweetId: string;
  tweetText: string;
  sourceHandle: string;
  sourceTier: number;
  playerName: string;
  eventType: EventType;
  confidenceTier: ConfidenceTier;
  confidenceScore: number;
  destinationTeam: string | null;
  sentiment: Sentiment;
  timestamp: number;
  fastPathMatch: boolean;
  llmClassification: Record<string, unknown> | null;
}

interface PlayerContext {
  playerName: string;
  signals: Signal[];
  currentTeam: string | null;
  position: string | null;
  lastUpdated: number;
}

interface TeamContext {
  teamName: string;
  needs: string[];
  capSpace: number | null;
  recentSignals: Signal[];
  lastUpdated: number;
}

// =============================================================================
// IN-MEMORY STATE
// =============================================================================

// Market caches
const allMarkets = new Map<string, NFLMarket>();        // ticker -> market
const playerMarkets = new Map<string, PlayerMap>();      // normalized player name -> markets

// Context maps (built by deep analysis)
const playerContexts = new Map<string, PlayerContext>();  // player name -> context
const teamContexts = new Map<string, TeamContext>();      // team name -> context

// Twitter polling state
const lastTweetIds = new Map<string, string>();           // handle -> last seen tweet ID

// Dedup & signal tracking
const tradedSignals = new Set<string>();                  // "playerName:ticker" dedup keys
const recentSignals: Signal[] = [];                       // Rolling window of recent signals

// Operator overrides (for manual intervention via Supabase)
const overrides = {
  killedPlayers: new Set<string>(),                       // Players we won't trade
  maxPriceOverrides: new Map<string, number>(),           // ticker -> max price override
  confidenceBoosts: new Map<string, number>(),            // player -> confidence boost
  positionSizeMultiplier: 1.0,                            // Global size multiplier
  teamNeedsOverrides: new Map<string, string[]>(),        // team -> needs override
};

// Market refresh tracking
let lastMarketRefresh = 0;

// =============================================================================
// KALSHI AUTH (RSA-PSS signing)
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
// KALSHI API HELPERS
// =============================================================================

async function kalshiFetch<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T | null> {
  try {
    const headers = await getKalshiHeaders(method, path);
    const response = await fetch(`https://api.elections.kalshi.com${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[KALSHI] ${method} ${path} failed (${response.status}): ${error}`);
      return null;
    }

    return await response.json() as T;
  } catch (e) {
    console.error(`[KALSHI] ${method} ${path} error:`, e);
    return null;
  }
}

async function getBalance(): Promise<{ balance: number; portfolioValue: number } | null> {
  const path = "/trade-api/v2/portfolio/balance";
  const data = await kalshiFetch<{ balance: number; portfolio_value: number }>("GET", path);
  if (!data) return null;
  return {
    balance: data.balance ?? 0,
    portfolioValue: data.portfolio_value ?? 0,
  };
}

async function getPositions(): Promise<Array<{ ticker: string; contracts: number; side: "yes" | "no" }>> {
  const path = "/trade-api/v2/portfolio/positions";
  const data = await kalshiFetch<{ market_positions: Array<{ ticker: string; position: number; no_position: number }> }>("GET", path);
  if (!data) return [];

  const positions: Array<{ ticker: string; contracts: number; side: "yes" | "no" }> = [];

  for (const p of data.market_positions ?? []) {
    // CRITICAL: Kalshi has SEPARATE position (YES) and no_position (NO) fields
    // Do NOT treat as a single signed field — that was the NBA bot bug
    if (p.position && p.position > 0) {
      positions.push({
        ticker: p.ticker,
        contracts: p.position,
        side: "yes",
      });
    }
    if (p.no_position && p.no_position > 0) {
      positions.push({
        ticker: p.ticker,
        contracts: p.no_position,
        side: "no",
      });
    }
  }

  return positions;
}

// =============================================================================
// TELEGRAM NOTIFICATIONS
// =============================================================================

async function sendTelegram(message: string, retries = 3): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      });

      if (response.ok) return;

      if (response.status >= 400 && response.status < 500) {
        console.error(`[TELEGRAM] Error ${response.status}`);
        return;
      }

      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 500;
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (e) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 500;
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error("[TELEGRAM] Failed after retries:", e);
      }
    }
  }
}

// =============================================================================
// ORDER PLACEMENT
// =============================================================================

async function placeOrder(
  ticker: string,
  side: "yes" | "no",
  priceCents: number,
  quantity: number,
  signal: Signal,
): Promise<{ success: boolean; error?: string }> {
  // Kill switch
  if (NFL_TRADING_DISABLED) {
    console.log(`[ORDER] BLOCKED (trading disabled): ${side.toUpperCase()} ${quantity}x ${ticker} @ ${priceCents}¢`);
    await sendTelegram(
      `🚫 <b>ORDER BLOCKED (disabled)</b>\n\n` +
      `${side.toUpperCase()} ${quantity}x ${ticker} @ ${priceCents}¢\n` +
      `Signal: ${signal.confidenceTier} ${signal.eventType}\n` +
      `Source: @${signal.sourceHandle}\n` +
      `Player: ${signal.playerName}`
    );
    return { success: false, error: "NFL_TRADING_DISABLED" };
  }

  // Killed player check
  if (overrides.killedPlayers.has(signal.playerName.toLowerCase())) {
    console.log(`[ORDER] BLOCKED (killed player): ${signal.playerName}`);
    return { success: false, error: "Player killed by operator" };
  }

  // Max spend check
  const orderCostCents = priceCents * quantity;
  if (orderCostCents > MAX_SPEND_PER_TRADE_CENTS) {
    console.log(`[ORDER] SKIP: cost ${orderCostCents}¢ > max ${MAX_SPEND_PER_TRADE_CENTS}¢`);
    return { success: false, error: `Order cost ${orderCostCents}¢ exceeds max ${MAX_SPEND_PER_TRADE_CENTS}¢` };
  }

  // Balance check
  const balance = await getBalance();
  if (balance && balance.balance < orderCostCents) {
    const msg = `Insufficient balance: ${balance.balance}¢ < order cost ${orderCostCents}¢`;
    console.log(`[ORDER] SKIP: ${msg}`);
    await sendTelegram(
      `⚠️ <b>INSUFFICIENT BALANCE</b>\n\n` +
      `Tried: ${side.toUpperCase()} ${quantity}x ${ticker} @ ${priceCents}¢\n` +
      `Cost: $${(orderCostCents / 100).toFixed(2)}\n` +
      `Balance: $${(balance.balance / 100).toFixed(2)}`
    );
    return { success: false, error: msg };
  }

  // Max price check (from confidence config or operator override)
  const maxPrice = overrides.maxPriceOverrides.get(ticker)
    ?? CONFIDENCE_CONFIG[signal.confidenceTier]?.maxPrice
    ?? 50;
  if (priceCents > maxPrice) {
    console.log(`[ORDER] SKIP: price ${priceCents}¢ > max ${maxPrice}¢ for ${signal.confidenceTier}`);
    return { success: false, error: `Price ${priceCents}¢ > max ${maxPrice}¢` };
  }

  // Place the order
  const orderPath = "/trade-api/v2/portfolio/orders";
  const clientOrderId = `nflfa-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const limitPrice = priceCents;

  const orderBody = {
    ticker,
    client_order_id: clientOrderId,
    type: "limit",
    action: "buy",
    side,
    count: quantity,
    yes_price: side === "yes" ? limitPrice : undefined,
    no_price: side === "no" ? limitPrice : undefined,
  };

  const orderHeaders = await getKalshiHeaders("POST", orderPath);
  try {
    const response = await fetch(`https://api.elections.kalshi.com${orderPath}`, {
      method: "POST",
      headers: orderHeaders,
      body: JSON.stringify(orderBody),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[ORDER] Failed: ${error}`);
      return { success: false, error };
    }

    const result = await response.json();
    console.log(`[ORDER] BUY ${quantity} ${side.toUpperCase()} on ${ticker} @ ${priceCents}¢ - ${result.order?.status}`);

    // Log to Supabase
    try {
      await supabase.from("nfl_trades").insert({
        market_ticker: ticker,
        order_id: result.order?.order_id || clientOrderId,
        side,
        action: "buy",
        price_cents: priceCents,
        quantity: quantity,
        market_type: ticker.includes("KXNFLTRADE") ? "nfltrade" : "nextteam",
        status: result.order?.status || "submitted",
        meta: {
          source: BOT_ID,
          client_order_id: clientOrderId,
          player_name: signal.playerName,
          event_type: signal.eventType,
          confidence_tier: signal.confidenceTier,
          destination_team: signal.destinationTeam,
          tweet_id: signal.tweetId,
          tweet_text: signal.tweetText,
          source_handle: signal.sourceHandle,
          source_tier: signal.sourceTier,
          fast_path_match: signal.fastPathMatch,
        },
      });
    } catch (e) {
      console.error("[ORDER] Error recording trade to Supabase:", e);
    }

    // Telegram notification
    await sendTelegram(
      `🏈 <b>NFL FA ORDER PLACED</b>\n\n` +
      `${side.toUpperCase()} ${quantity}x ${ticker} @ ${priceCents}¢\n` +
      `Player: ${signal.playerName}\n` +
      `Event: ${signal.eventType} (${signal.confidenceTier})\n` +
      `Source: @${signal.sourceHandle} (Tier ${signal.sourceTier})\n` +
      `Status: ${result.order?.status || "submitted"}`
    );

    // Mark as traded for dedup
    tradedSignals.add(`${signal.playerName.toLowerCase()}:${ticker}`);

    return { success: true };
  } catch (e) {
    console.error("[ORDER] Error:", e);
    return { success: false, error: String(e) };
  }
}

// =============================================================================
// MARKET DISCOVERY
// =============================================================================

function extractPlayerName(title: string, marketType: MarketType): string | null {
  if (marketType === "nfltrade") {
    // "Will Patrick Mahomes be traded?" / "Patrick Mahomes traded before ..."
    const match = title.match(/will\s+(.+?)\s+be\s+traded/i);
    if (match) return match[1].trim();
    const match2 = title.match(/^(.+?)\s+traded\s+before/i);
    if (match2) return match2[1].trim();
    // "Will X sign with a new team?" / "Will X leave?"
    const match3 = title.match(/will\s+(.+?)\s+sign\s+with/i);
    if (match3) return match3[1].trim();
    const match4 = title.match(/will\s+(.+?)\s+leave/i);
    if (match4) return match4[1].trim();
  }

  if (marketType === "nextteam") {
    // "What will be Saquon Barkley's next team?"
    const match = title.match(/what will be\s+(.+?)'s\s+next\s+team/i);
    if (match) return match[1].trim();
    // "Where will X sign?"
    const match2 = title.match(/where will\s+(.+?)\s+sign/i);
    if (match2) return match2[1].trim();
    // Fallback: "X's Next Team"
    const match3 = title.match(/^(.+?)'s\s+next\s+team/i);
    if (match3) return match3[1].trim();
  }

  return null;
}

function extractTeamName(subtitle: string): string | null {
  if (!subtitle) return null;
  // Subtitles often like "Yes: Dallas Cowboys" or just "Dallas Cowboys"
  const cleaned = subtitle.replace(/^(yes|no):\s*/i, "").trim();
  return cleaned || null;
}

function normalizePlayerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

async function refreshMarkets(): Promise<void> {
  const now = Date.now();
  if (now - lastMarketRefresh < MARKET_REFRESH_MS && allMarkets.size > 0) {
    return;
  }

  console.log("[MARKETS] Refreshing NFL markets...");

  // Fetch NFL trade markets (KXNFLTRADE series)
  try {
    const path = `/trade-api/v2/markets?series_ticker=KXNFLTRADE&status=open&limit=200`;
    const headers = await getKalshiHeaders("GET", path);
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });

    if (response.ok) {
      const data = await response.json();
      let tradeCount = 0;

      for (const m of data.markets ?? []) {
        const playerName = extractPlayerName(m.title ?? "", "nfltrade");
        if (!playerName) continue;

        const market: NFLMarket = {
          ticker: m.ticker,
          title: m.title ?? "",
          subtitle: m.yes_sub_title ?? "",
          playerName,
          teamName: null,
          marketType: "nfltrade",
          yesPrice: m.last_price ?? 50,
          noPrice: 100 - (m.last_price ?? 50),
          volume: m.volume ?? 0,
          openInterest: m.open_interest ?? 0,
          seriesTicker: "KXNFLTRADE",
          status: m.status ?? "open",
        };

        allMarkets.set(m.ticker, market);
        tradeCount++;

        // Build player map
        const key = normalizePlayerName(playerName);
        if (!playerMarkets.has(key)) {
          playerMarkets.set(key, {
            playerName,
            tradeMarket: null,
            nextTeamMarkets: new Map(),
          });
        }
        playerMarkets.get(key)!.tradeMarket = market;
      }

      console.log(`[MARKETS] Loaded ${tradeCount} NFL trade markets`);
    }
  } catch (e) {
    console.error("[MARKETS] Error fetching KXNFLTRADE:", e);
  }

  // Fetch next team markets (KXNEXTTEAMNFL series)
  try {
    const path = `/trade-api/v2/markets?series_ticker=KXNEXTTEAMNFL&status=open&limit=200`;
    const headers = await getKalshiHeaders("GET", path);
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });

    if (response.ok) {
      const data = await response.json();
      let nextTeamCount = 0;

      for (const m of data.markets ?? []) {
        const playerName = extractPlayerName(m.title ?? "", "nextteam");
        if (!playerName) continue;

        const teamName = extractTeamName(m.yes_sub_title ?? "") ?? m.custom_strike?.Team ?? null;
        const teamCode = m.ticker.split("-").pop() ?? "";

        const market: NFLMarket = {
          ticker: m.ticker,
          title: m.title ?? "",
          subtitle: m.yes_sub_title ?? "",
          playerName,
          teamName,
          marketType: "nextteam",
          yesPrice: m.last_price ?? 50,
          noPrice: 100 - (m.last_price ?? 50),
          volume: m.volume ?? 0,
          openInterest: m.open_interest ?? 0,
          seriesTicker: "KXNEXTTEAMNFL",
          status: m.status ?? "open",
        };

        allMarkets.set(m.ticker, market);
        nextTeamCount++;

        // Build player map
        const key = normalizePlayerName(playerName);
        if (!playerMarkets.has(key)) {
          playerMarkets.set(key, {
            playerName,
            tradeMarket: null,
            nextTeamMarkets: new Map(),
          });
        }
        playerMarkets.get(key)!.nextTeamMarkets.set(teamCode, market);
      }

      console.log(`[MARKETS] Loaded ${nextTeamCount} NFL next-team markets`);
    }
  } catch (e) {
    console.error("[MARKETS] Error fetching KXNEXTTEAMNFL:", e);
  }

  // Upsert to Supabase for the UI
  const upsertRows = Array.from(allMarkets.values()).map(m => ({
    venue: "kalshi",
    venue_market_ticker: m.ticker,
    venue_series_ticker: m.seriesTicker,
    title: m.title,
    category: "sports",
    status: m.status,
    yes_price_last: m.yesPrice / 100,
  }));

  if (upsertRows.length > 0) {
    try {
      await supabase.from("markets").upsert(upsertRows, { onConflict: "venue,venue_market_ticker" });
    } catch (e) {
      console.error("[MARKETS] Error upserting markets to Supabase:", e);
    }
  }

  lastMarketRefresh = now;
  console.log(`[MARKETS] Total: ${allMarkets.size} markets, ${playerMarkets.size} players`);
}

// =============================================================================
// TASK 5: TWITTER POLLING WITH TIERED INTERVALS
// =============================================================================

async function resolveUserIds(): Promise<void> {
  const handles = TWITTER_SOURCES.filter(s => !s.userId).map(s => s.handle);
  if (handles.length === 0) return;

  // Twitter API allows up to 100 usernames per request
  const batchSize = 100;
  for (let i = 0; i < handles.length; i += batchSize) {
    const batch = handles.slice(i, i + batchSize);
    const url = `https://api.x.com/2/users/by?usernames=${batch.join(",")}`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
      });

      if (response.status === 429) {
        const resetAt = response.headers.get("x-rate-limit-reset");
        const waitMs = resetAt ? (parseInt(resetAt) * 1000 - Date.now() + 1000) : 60_000;
        console.warn(`[TWITTER] Rate limited on user lookup, waiting ${Math.round(waitMs / 1000)}s`);
        await new Promise(r => setTimeout(r, waitMs));
        i -= batchSize; // retry this batch
        continue;
      }

      if (!response.ok) {
        console.error(`[TWITTER] User lookup failed (${response.status}): ${await response.text()}`);
        continue;
      }

      const data = await response.json();
      for (const user of data.data ?? []) {
        const source = TWITTER_SOURCES.find(
          s => s.handle.toLowerCase() === user.username.toLowerCase()
        );
        if (source) {
          source.userId = user.id;
          console.log(`[TWITTER] Resolved @${source.handle} → ${user.id}`);
        }
      }
    } catch (e) {
      console.error("[TWITTER] Error resolving user IDs:", e);
    }
  }

  const unresolved = TWITTER_SOURCES.filter(s => !s.userId);
  if (unresolved.length > 0) {
    console.warn(`[TWITTER] Could not resolve: ${unresolved.map(s => s.handle).join(", ")}`);
  }
}

async function fetchTweets(userId: string): Promise<Array<{ id: string; text: string; created_at: string }>> {
  const source = TWITTER_SOURCES.find(s => s.userId === userId);
  if (!source) return [];

  let url = `https://api.x.com/2/users/${userId}/tweets?max_results=5&tweet.fields=created_at`;
  const sinceId = lastTweetIds.get(source.handle);
  if (sinceId) {
    url += `&since_id=${sinceId}`;
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
    });

    if (response.status === 429) {
      const resetAt = response.headers.get("x-rate-limit-reset");
      const waitMs = resetAt ? (parseInt(resetAt) * 1000 - Date.now() + 1000) : 60_000;
      console.warn(`[TWITTER] Rate limited on @${source.handle}, waiting ${Math.round(waitMs / 1000)}s`);
      await new Promise(r => setTimeout(r, waitMs));
      return [];
    }

    if (!response.ok) {
      console.error(`[TWITTER] Fetch tweets @${source.handle} failed (${response.status})`);
      return [];
    }

    const data = await response.json();
    const tweets: Array<{ id: string; text: string; created_at: string }> = data.data ?? [];

    // Update since_id to the newest tweet
    if (tweets.length > 0) {
      // Tweets come newest-first; store the highest ID
      const newestId = tweets.reduce((max, t) =>
        BigInt(t.id) > BigInt(max) ? t.id : max, tweets[0].id
      );
      lastTweetIds.set(source.handle, newestId);
    }

    return tweets;
  } catch (e) {
    console.error(`[TWITTER] Error fetching tweets for @${source?.handle}:`, e);
    return [];
  }
}

const pollingIntervals: number[] = [];

function startTwitterPolling(): void {
  const tiers = new Set(TWITTER_SOURCES.map(s => s.tier));

  for (const tier of tiers) {
    const intervalMs = TIER_POLL_MS[tier] ?? 60_000;
    const sources = TWITTER_SOURCES.filter(s => s.tier === tier && s.userId);

    if (sources.length === 0) {
      console.warn(`[TWITTER] No resolved sources for Tier ${tier}, skipping`);
      continue;
    }

    console.log(`[TWITTER] Starting Tier ${tier} polling (${sources.length} sources, every ${intervalMs / 1000}s)`);

    const intervalId = setInterval(async () => {
      for (const source of sources) {
        try {
          const tweets = await fetchTweets(source.userId);
          // Process tweets oldest-first so signal chain is chronological
          for (const tweet of tweets.reverse()) {
            await processTweet(tweet, source);
          }
        } catch (e) {
          console.error(`[TWITTER] Error polling @${source.handle}:`, e);
        }
      }
    }, intervalMs);

    pollingIntervals.push(intervalId);
  }
}

// =============================================================================
// TASK 6: REGEX FAST-PATH + SIGNAL PROCESSING
// =============================================================================

function extractPlayerFromContext(beforeMatch: string, fullText: string): string | null {
  // First: try matching known player names from our market data
  for (const [_key, pm] of playerMarkets) {
    const name = pm.playerName;
    if (fullText.toLowerCase().includes(name.toLowerCase())) {
      return name;
    }
  }

  // Fallback: extract proper noun sequences (capitalized words) from before the match
  // Look for 2-3 word sequences of capitalized words just before the match
  const words = beforeMatch.trim().split(/\s+/);
  const properNouns: string[] = [];

  // Walk backwards through words to find proper noun sequence
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i].replace(/[^a-zA-Z']/g, "");
    if (word && /^[A-Z]/.test(word)) {
      properNouns.unshift(word);
    } else {
      break;
    }
    if (properNouns.length >= 3) break;
  }

  if (properNouns.length >= 2) {
    return properNouns.join(" ");
  }

  // Last resort: try to find proper nouns anywhere in the text
  const allProper = fullText.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
  if (allProper && allProper.length > 0) {
    // Return the first multi-word proper noun that looks like a person name
    return allProper[0];
  }

  return null;
}

function tryFastPath(text: string): {
  eventType: string;
  tier: string;
  team: string | null;
  languagePattern: string;
  playerName: string | null;
} | null {
  for (const fp of FAST_PATH_PATTERNS) {
    const match = text.match(fp.pattern);
    if (match) {
      // Team captured from regex group 1 (if present)
      const team = match[1]?.replace(/[.!?,;].*$/, "").trim() ?? null;
      const languagePattern = match[0];

      // Try to extract player name from context before the match
      const matchIndex = text.indexOf(match[0]);
      const beforeMatch = text.substring(0, matchIndex);

      const playerName = extractPlayerFromContext(beforeMatch, text);

      return {
        eventType: fp.eventType,
        tier: fp.tier,
        team,
        languagePattern,
        playerName,
      };
    }
  }
  return null;
}

async function saveSignal(signal: Signal): Promise<Signal> {
  try {
    const { data, error } = await supabase.from("nfl_signals").insert({
      player_name: signal.playerName,
      team: signal.destinationTeam,
      event_type: signal.eventType,
      confidence_tier: signal.confidenceTier,
      confidence_score: signal.confidenceScore,
      source_author: signal.sourceHandle,
      source_tier: signal.sourceTier,
      raw_text: signal.tweetText,
      llm_classification: signal.llmClassification,
      language_pattern: signal.fastPathMatch,
      meta: {
        bot_id: BOT_ID,
        timestamp: signal.timestamp,
        tweet_id: signal.tweetId,
        sentiment: signal.sentiment,
      },
    }).select("id").single();

    if (error) {
      console.error("[SIGNAL] Error saving signal:", error);
    } else if (data) {
      signal.id = data.id;
    }
  } catch (e) {
    console.error("[SIGNAL] Error saving signal:", e);
  }

  // Add to rolling buffer, cap at 500
  recentSignals.push(signal);
  if (recentSignals.length > 500) {
    recentSignals.splice(0, recentSignals.length - 500);
  }

  return signal;
}

async function processTweet(
  tweet: { id: string; text: string; created_at: string },
  source: { handle: string; userId: string; tier: number },
): Promise<void> {
  console.log(`[SIGNAL] Processing tweet from @${source.handle}: ${tweet.text.substring(0, 80)}...`);

  // Check regex fast-path
  const fastPath = tryFastPath(tweet.text);

  if (fastPath && source.tier <= 2) {
    // FAST PATH: Tier 1-2 source + regex match → trade immediately + LLM in parallel
    console.log(`[SIGNAL] FAST PATH: ${fastPath.eventType} detected from @${source.handle} (Tier ${source.tier})`);

    const signal: Signal = {
      id: "",
      tweetId: tweet.id,
      tweetText: tweet.text,
      sourceHandle: source.handle,
      sourceTier: source.tier,
      playerName: fastPath.playerName ?? "UNKNOWN",
      eventType: fastPath.eventType as EventType,
      confidenceTier: fastPath.tier as ConfidenceTier,
      confidenceScore: fastPath.tier === "confirmed" ? 95 : fastPath.tier === "strong_intel" ? 80 : fastPath.tier === "developing" ? 55 : 20,
      destinationTeam: fastPath.team,
      sentiment: fastPath.eventType === "trade" || fastPath.eventType === "signing" ? "rising" : "falling",
      timestamp: Date.now(),
      fastPathMatch: true,
      llmClassification: null,
    };

    // Fire trade + LLM in parallel
    const [, llmResult] = await Promise.all([
      (async () => {
        if (signal.playerName !== "UNKNOWN") {
          const saved = await saveSignal(signal);
          await executeTradesForSignal(saved);
        } else {
          console.log("[SIGNAL] Fast path skipped trade: no player identified");
        }
      })(),
      classifyWithLLM(tweet.text, source),
    ]);

    // If LLM disagrees with fast-path, alert
    if (llmResult) {
      signal.llmClassification = llmResult as unknown as Record<string, unknown>;

      const llmEventType = llmResult.event_type;
      const llmPlayer = llmResult.player_name;

      if (llmEventType !== fastPath.eventType || (llmPlayer && signal.playerName !== "UNKNOWN" && llmPlayer.toLowerCase() !== signal.playerName.toLowerCase())) {
        const disagreement = `FAST PATH vs LLM DISAGREEMENT\n` +
          `Fast: ${fastPath.eventType} / ${signal.playerName}\n` +
          `LLM: ${llmEventType} / ${llmPlayer}\n` +
          `Tweet: ${tweet.text.substring(0, 200)}`;
        console.warn(`[SIGNAL] ${disagreement}`);
        await sendTelegram(`⚠️ <b>${disagreement}</b>`);
      }

      // If fast path couldn't identify player but LLM did, execute trade now
      if (signal.playerName === "UNKNOWN" && llmPlayer) {
        signal.playerName = llmPlayer;
        signal.destinationTeam = llmResult.team ?? signal.destinationTeam;
        const saved = await saveSignal(signal);
        await executeTradesForSignal(saved);
      }
    }
  } else {
    // NO FAST PATH or Tier 3: wait for LLM classification
    const llmResult = await classifyWithLLM(tweet.text, source);

    if (!llmResult) {
      console.log(`[SIGNAL] LLM returned no classification for tweet ${tweet.id}`);
      return;
    }

    const signal: Signal = {
      id: "",
      tweetId: tweet.id,
      tweetText: tweet.text,
      sourceHandle: source.handle,
      sourceTier: source.tier,
      playerName: llmResult.player_name ?? "UNKNOWN",
      eventType: (llmResult.event_type as EventType) ?? "rumor",
      confidenceTier: (llmResult.confidence_tier as ConfidenceTier) ?? "speculation",
      confidenceScore: llmResult.confidence_score ?? 0,
      destinationTeam: llmResult.team ?? null,
      sentiment: llmResult.event_type === "trade" || llmResult.event_type === "signing" ? "rising" : "falling",
      timestamp: Date.now(),
      fastPathMatch: !!fastPath,
      llmClassification: llmResult as unknown as Record<string, unknown>,
    };

    if (signal.playerName === "UNKNOWN") {
      console.log(`[SIGNAL] No player identified in tweet ${tweet.id}, skipping`);
      return;
    }

    const saved = await saveSignal(signal);
    await executeTradesForSignal(saved);
  }
}

// =============================================================================
// TASK 7: LLM CLASSIFICATION VIA GROQ
// =============================================================================

interface LLMClassification {
  player_name: string | null;
  team: string | null;
  event_type: string;
  confidence_tier: string;
  confidence_score: number;
  language_pattern: string;
  reasoning: string;
}

async function classifyWithLLM(
  tweetText: string,
  source: { handle: string; tier: number },
): Promise<LLMClassification | null> {
  const startTime = Date.now();

  // Build known players list for matching
  const knownPlayers = Array.from(playerMarkets.values()).map(pm => pm.playerName);

  const systemPrompt = `You are an NFL free agency signal classifier. Analyze tweets from NFL insiders and extract structured data.

KNOWN PLAYERS WITH ACTIVE MARKETS:
${knownPlayers.join(", ")}

LANGUAGE CONFIDENCE MAPPING (use these to set confidence_tier and confidence_score):
- "has been traded to" → confirmed (95-99)
- "has agreed to" / "is signing" → confirmed (93-99)
- "is finalizing" / "nearing a deal" → strong_intel (80-89)
- "is expected to" / "likely to" → strong_intel (70-79)
- "in serious discussions" → developing (50-65)
- "has interest" / "exploring" / "could" → speculation (10-30)

EVENT TYPES (choose one):
- trade: Player traded from one team to another
- signing: Player signs with a team as free agent
- cut: Player cut from roster
- release: Player released
- extension: Player extends with current team
- rumor: Unconfirmed rumor or speculation
- cap_move: Salary cap related move (restructure, etc.)

SOURCE INFO:
- Handle: @${source.handle}
- Tier: ${source.tier} (1=fastest/most reliable, 2=reliable, 3=official)

RULES:
1. Match player names against the KNOWN PLAYERS list when possible
2. If no player can be identified, set player_name to null
3. Set confidence_score to 0 if the tweet is not about a player transaction
4. Extract the destination team if mentioned

Respond with JSON only.`;

  const userPrompt = `Classify this tweet:

"${tweetText}"

Respond with this exact JSON structure:
{
  "player_name": "string or null",
  "team": "destination team name or null",
  "event_type": "trade|signing|cut|release|extension|rumor|cap_move",
  "confidence_tier": "confirmed|strong_intel|developing|speculation",
  "confidence_score": 0-100,
  "language_pattern": "the key phrase that determined confidence",
  "reasoning": "brief explanation"
}`;

  try {
    // Rate limit: minimum 1.5s between LLM calls
    const now = Date.now();
    const elapsed = now - lastLlmCallMs;
    if (elapsed < 1500) {
      await new Promise(r => setTimeout(r, 1500 - elapsed));
    }
    lastLlmCallMs = Date.now();

    const requestBody = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 400,
      response_format: { type: "json_object" },
    });

    let response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
    });

    // Handle rate limiting: wait and retry once
    if (response.status === 429) {
      const retryAfter = 2000;
      console.warn(`[LLM] Rate limited, waiting ${retryAfter}ms...`);
      await new Promise(r => setTimeout(r, retryAfter));
      lastLlmCallMs = Date.now();
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
      });
    }

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();
      console.error(`[LLM] Groq API error (${response.status}): ${error}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[LLM] No content in Groq response");
      return null;
    }

    const result: LLMClassification = JSON.parse(content);
    console.log(`[LLM] Classified in ${latencyMs}ms: ${result.event_type} / ${result.player_name} / ${result.confidence_tier} (${result.confidence_score})`);

    // Return null if no player or zero confidence
    if (!result.player_name || result.confidence_score === 0) {
      console.log(`[LLM] Skipping: no player or zero confidence`);
      return null;
    }

    return result;
  } catch (e) {
    const latencyMs = Date.now() - startTime;
    console.error(`[LLM] Error after ${latencyMs}ms:`, e);
    return null;
  }
}

// =============================================================================
// TASK 8: TRADE EXECUTION ENGINE
// =============================================================================

function findPlayerMarkets(playerName: string): PlayerMap | null {
  // Exact match
  const key = normalizePlayerName(playerName);
  if (playerMarkets.has(key)) return playerMarkets.get(key)!;

  // First/last name fuzzy match (handles "JK Dobbins" vs "J.K. Dobbins")
  const keyParts = key.split(" ");
  if (keyParts.length >= 2) {
    for (const [k, pm] of playerMarkets) {
      const kParts = k.split(" ");
      if (kParts.length >= 2 && kParts[kParts.length - 1] === keyParts[keyParts.length - 1]) {
        // Same last name — check first name starts with same letter
        if (kParts[0][0] === keyParts[0][0]) return pm;
      }
    }
  }

  // Case-insensitive match
  for (const [k, pm] of playerMarkets) {
    if (k === key) return pm;
  }

  // Last-name match only if first name also starts with same letter (avoid Trent Brown → AJ Brown)
  const nameParts = playerName.trim().split(/\s+/);
  if (nameParts.length >= 2) {
    const firstName = nameParts[0].toLowerCase();
    const lastName = nameParts[nameParts.length - 1].toLowerCase();
    if (lastName.length >= 3) {
      for (const [k, pm] of playerMarkets) {
        const kParts = k.split(" ");
        if (kParts.length >= 2) {
          const kLast = kParts[kParts.length - 1];
          const kFirst = kParts[0];
          if (kLast === lastName && kFirst[0] === firstName[0]) return pm;
        }
      }
    }
  }

  return null;
}

// NFL team nickname → Kalshi-style city/name mapping
const TEAM_ALIASES: Record<string, string[]> = {
  "49ers": ["san francisco", "sf"], "bears": ["chicago", "chi"], "bengals": ["cincinnati", "cin"],
  "bills": ["buffalo", "buf"], "broncos": ["denver", "den"], "browns": ["cleveland", "cle"],
  "buccaneers": ["tampa bay", "tb", "bucs"], "cardinals": ["arizona", "ari"],
  "chargers": ["los angeles c", "lac", "la chargers"], "chiefs": ["kansas city", "kc"],
  "colts": ["indianapolis", "ind"], "commanders": ["washington", "was"],
  "cowboys": ["dallas", "dal"], "dolphins": ["miami", "mia"], "eagles": ["philadelphia", "phi"],
  "falcons": ["atlanta", "atl"], "giants": ["new york g", "nyg"], "jaguars": ["jacksonville", "jax"],
  "jets": ["new york j", "nyj"], "lions": ["detroit", "det"], "packers": ["green bay", "gb"],
  "panthers": ["carolina", "car"], "patriots": ["new england", "ne"], "raiders": ["las vegas", "lv"],
  "rams": ["los angeles r", "lar", "la rams"], "ravens": ["baltimore", "bal"],
  "saints": ["new orleans", "no"], "seahawks": ["seattle", "sea"], "steelers": ["pittsburgh", "pit"],
  "texans": ["houston", "hou"], "titans": ["tennessee", "ten"], "vikings": ["minnesota", "min"],
};

function normalizeTeamName(name: string): string[] {
  const lower = name.toLowerCase().trim();
  const results = [lower];
  // Check if the name is a nickname or contains one
  for (const [nickname, aliases] of Object.entries(TEAM_ALIASES)) {
    if (lower.includes(nickname) || aliases.some(a => lower.includes(a))) {
      results.push(nickname, ...aliases);
    }
  }
  // Also split "San Francisco 49ers" → ["san francisco", "49ers"]
  const parts = lower.split(/\s+/);
  if (parts.length > 1) results.push(parts[parts.length - 1]);
  return [...new Set(results)];
}

function findNextTeamTicker(pm: PlayerMap, teamName: string): NFLMarket | null {
  if (!teamName) return null;

  const teamVariants = normalizeTeamName(teamName);

  // Try each variant
  for (const variant of teamVariants) {
    // Exact match on team name or ticker code
    for (const [code, market] of pm.nextTeamMarkets) {
      if (market.teamName?.toLowerCase() === variant) return market;
      if (code.toLowerCase() === variant) return market;
    }

    // Partial match
    for (const [code, market] of pm.nextTeamMarkets) {
      const mTeam = market.teamName?.toLowerCase() ?? "";
      if (mTeam.includes(variant) || variant.includes(mTeam)) return market;
      if (code.toLowerCase().includes(variant) || variant.includes(code.toLowerCase())) return market;
    }
  }

  // Partial/contains: check if team name words appear in market team name
  const teamWords = teamName.toLowerCase().trim().split(/\s+/);
  for (const [_code, market] of pm.nextTeamMarkets) {
    const mTeam = market.teamName?.toLowerCase() ?? "";
    if (teamWords.some(w => w.length >= 3 && mTeam.includes(w))) return market;
  }

  return null;
}

function calculateQuantity(priceCents: number, sizeMultiplier: number): number {
  if (priceCents <= 0) return MIN_CONTRACTS;

  const rawQuantity = Math.floor(
    (MAX_SPEND_PER_TRADE_CENTS * sizeMultiplier * overrides.positionSizeMultiplier) / priceCents
  );

  return Math.max(MIN_CONTRACTS, Math.min(MAX_CONTRACTS, rawQuantity));
}

async function executeTradesForSignal(signal: Signal): Promise<void> {
  // Kill switch
  if (NFL_TRADING_DISABLED) {
    console.log(`[TRADE] Kill switch active, logging signal only: ${signal.eventType} / ${signal.playerName}`);
    await sendTelegram(
      `📋 <b>NFL SIGNAL (trading disabled)</b>\n\n` +
      `Event: ${signal.eventType} (${signal.confidenceTier})\n` +
      `Player: ${signal.playerName}\n` +
      `Team: ${signal.destinationTeam ?? "N/A"}\n` +
      `Source: @${signal.sourceHandle} (Tier ${signal.sourceTier})\n` +
      `Fast path: ${signal.fastPathMatch ? "Yes" : "No"}\n` +
      `Tweet: ${signal.tweetText.substring(0, 200)}`
    );
    return;
  }

  // Killed player check
  if (overrides.killedPlayers.has(signal.playerName.toLowerCase())) {
    console.log(`[TRADE] Player killed by operator: ${signal.playerName}`);
    return;
  }

  // Skip speculation tier
  if (signal.confidenceTier === "speculation") {
    console.log(`[TRADE] Skipping speculation-tier signal: ${signal.playerName} / ${signal.eventType}`);
    return;
  }

  // Dedup check
  const pm = findPlayerMarkets(signal.playerName);
  if (!pm) {
    console.log(`[TRADE] No markets found for player: ${signal.playerName}`);
    await sendTelegram(
      `⚠️ <b>NO MARKETS</b> for ${signal.playerName}\n` +
      `Event: ${signal.eventType} (${signal.confidenceTier})\n` +
      `Source: @${signal.sourceHandle}`
    );
    return;
  }

  // Apply confidence boost/nerf
  let confidenceTier = signal.confidenceTier;
  const boost = overrides.confidenceBoosts.get(signal.playerName.toLowerCase());
  if (boost) {
    const tiers: ConfidenceTier[] = ["speculation", "developing", "strong_intel", "confirmed"];
    const currentIdx = tiers.indexOf(confidenceTier);
    const newIdx = Math.max(0, Math.min(tiers.length - 1, currentIdx + boost));
    confidenceTier = tiers[newIdx];
    console.log(`[TRADE] Confidence adjusted ${signal.confidenceTier} → ${confidenceTier} (boost: ${boost})`);
  }

  const config = CONFIDENCE_CONFIG[confidenceTier];
  if (!config || config.sizeMultiplier === 0) {
    console.log(`[TRADE] No trading config for tier: ${confidenceTier}`);
    return;
  }

  const orders: Promise<{ success: boolean; error?: string }>[] = [];

  // Route by event type
  switch (signal.eventType) {
    case "trade": {
      // BUY YES on NFLTRADE (player will be traded)
      if (pm.tradeMarket) {
        const dedupKey = `${signal.playerName.toLowerCase()}:${pm.tradeMarket.ticker}`;
        if (!tradedSignals.has(dedupKey) && pm.tradeMarket.yesPrice < 98) {
          const qty = calculateQuantity(config.maxPrice, config.sizeMultiplier);
          orders.push(placeOrder(pm.tradeMarket.ticker, "yes", config.maxPrice, qty, { ...signal, confidenceTier }));
        }
      }

      // BUY YES on NEXTTEAM (destination team)
      if (signal.destinationTeam) {
        const nextTeamMarket = findNextTeamTicker(pm, signal.destinationTeam);
        if (nextTeamMarket) {
          const dedupKey = `${signal.playerName.toLowerCase()}:${nextTeamMarket.ticker}`;
          if (!tradedSignals.has(dedupKey) && nextTeamMarket.yesPrice < 98) {
            const qty = calculateQuantity(config.maxPrice, config.sizeMultiplier);
            orders.push(placeOrder(nextTeamMarket.ticker, "yes", config.maxPrice, qty, { ...signal, confidenceTier }));
          }
        }
      }
      break;
    }

    case "signing": {
      // BUY YES on NEXTTEAM + BUY NO on NFLTRADE (signing means player won't be traded)
      console.log(`[TRADE] Signing handler: dest=${signal.destinationTeam}, nextTeamMarkets=${pm.nextTeamMarkets.size}`);
      if (pm.nextTeamMarkets.size > 0) {
        // Log available teams for debugging
        for (const [code, mkt] of pm.nextTeamMarkets) {
          console.log(`[TRADE]   Available: ${code} → ${mkt.teamName} (${mkt.ticker})`);
        }
      }
      if (signal.destinationTeam) {
        const nextTeamMarket = findNextTeamTicker(pm, signal.destinationTeam);
        console.log(`[TRADE] findNextTeamTicker result: ${nextTeamMarket?.ticker ?? "null"} for team "${signal.destinationTeam}" (yesPrice=${nextTeamMarket?.yesPrice ?? "?"})`);
        if (nextTeamMarket) {
          const dedupKey = `${signal.playerName.toLowerCase()}:${nextTeamMarket.ticker}`;
          if (!tradedSignals.has(dedupKey) && nextTeamMarket.yesPrice < 98) {
            const qty = calculateQuantity(config.maxPrice, config.sizeMultiplier);
            orders.push(placeOrder(nextTeamMarket.ticker, "yes", config.maxPrice, qty, { ...signal, confidenceTier }));
          }
        }
      }
      // Also BUY NO on NFLTRADE (signing means player won't be traded)
      if (pm.tradeMarket) {
        const dedupKey = `${signal.playerName.toLowerCase()}:${pm.tradeMarket.ticker}:no`;
        if (!tradedSignals.has(dedupKey) && pm.tradeMarket.noPrice < 98) {
          const qty = calculateQuantity(config.maxPrice, config.sizeMultiplier);
          orders.push(placeOrder(pm.tradeMarket.ticker, "no", config.maxPrice, qty, { ...signal, confidenceTier }));
        }
      }
      break;
    }

    case "cut":
    case "release": {
      // BUY NO on NFLTRADE (player can't be traded anymore)
      if (pm.tradeMarket) {
        const dedupKey = `${signal.playerName.toLowerCase()}:${pm.tradeMarket.ticker}:no`;
        if (!tradedSignals.has(dedupKey) && pm.tradeMarket.noPrice < 98) {
          const qty = calculateQuantity(config.maxPrice, config.sizeMultiplier);
          orders.push(placeOrder(pm.tradeMarket.ticker, "no", config.maxPrice, qty, { ...signal, confidenceTier }));
        }
      }
      break;
    }

    case "extension": {
      // BUY NO on NFLTRADE (extension means not being traded)
      if (pm.tradeMarket) {
        const dedupKey = `${signal.playerName.toLowerCase()}:${pm.tradeMarket.ticker}:no`;
        if (!tradedSignals.has(dedupKey) && pm.tradeMarket.noPrice < 98) {
          const qty = calculateQuantity(config.maxPrice, config.sizeMultiplier);
          orders.push(placeOrder(pm.tradeMarket.ticker, "no", config.maxPrice, qty, { ...signal, confidenceTier }));
        }
      }
      break;
    }

    case "rumor":
    case "cap_move":
    default: {
      // Rumor / cap_move → log only, no trade
      console.log(`[TRADE] No trade action for event type: ${signal.eventType}`);
      break;
    }
  }

  // Execute all orders in parallel
  if (orders.length > 0) {
    console.log(`[TRADE] Executing ${orders.length} order(s) for ${signal.playerName}...`);
    const results = await Promise.all(orders);
    const successes = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success).length;
    console.log(`[TRADE] Results: ${successes} success, ${failures} failed`);
  } else {
    console.log(`[TRADE] No orders to execute for ${signal.playerName} (${signal.eventType})`);
  }
}

// =============================================================================
// TASK 9: DEEP ANALYSIS LOOP (ANALYST BRAIN — SYSTEM 2)
// =============================================================================

async function runDeepAnalysis(): Promise<void> {
  console.log("[DEEP] Running deep analysis...");

  // 1. Query nfl_signals from last 48h
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: signals, error } = await supabase
    .from("nfl_signals")
    .select("*")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[DEEP] Error querying signals:", error);
    return;
  }

  if (!signals || signals.length === 0) {
    console.log("[DEEP] No signals in last 48h, skipping analysis");
    return;
  }

  // 2. Group signals by player and team
  const byPlayer = new Map<string, typeof signals>();
  const byTeam = new Map<string, typeof signals>();

  for (const s of signals) {
    const player = s.player_name?.toLowerCase();
    if (player) {
      if (!byPlayer.has(player)) byPlayer.set(player, []);
      byPlayer.get(player)!.push(s);
    }
    const team = s.team?.toLowerCase();
    if (team) {
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team)!.push(s);
    }
  }

  // 3. Build market context string
  let marketContext = "TRACKED PLAYERS & MARKETS:\n";
  for (const [key, pm] of playerMarkets) {
    const tradePrice = pm.tradeMarket ? `NFLTRADE YES: ${pm.tradeMarket.yesPrice}¢` : "No trade market";
    const topTeams = Array.from(pm.nextTeamMarkets.entries())
      .sort((a, b) => b[1].yesPrice - a[1].yesPrice)
      .slice(0, 5)
      .map(([code, m]) => `${m.teamName ?? code}: ${m.yesPrice}¢`)
      .join(", ");

    const signalCount = byPlayer.get(key)?.length ?? 0;
    marketContext += `- ${pm.playerName}: ${tradePrice} | Top teams: [${topTeams}] | Signals: ${signalCount}\n`;
  }

  // 4. Build signal summary
  let signalSummary = "\nRECENT SIGNALS (last 48h):\n";
  for (const s of signals.slice(-50)) { // Last 50 for context window
    signalSummary += `- @${s.source_handle} (Tier ${s.source_tier}): ${s.event_type} ${s.confidence_tier} — ${s.player_name}` +
      (s.team ? ` → ${s.team}` : "") +
      ` | "${(s.tweet_text ?? "").substring(0, 100)}"\n`;
  }

  const systemPrompt = `You are an elite NFL free agency analyst. You have deep knowledge of NFL team needs, salary cap dynamics, and player movement patterns.

Analyze the following market data and recent signals to provide strategic intelligence.

${marketContext}
${signalSummary}

Your analysis MUST cover:
1. PLAYER MOVEMENT ASSESSMENT: For each player with signals, assess movement likelihood (0-100) and most likely destination
2. SECOND-ORDER EFFECTS: If team signs WR, which other WRs linked to that team should be downgraded? If a player signs, what does that mean for others at the same position?
3. CROSS-MARKET MISPRICINGS: Compare NFLTRADE implied probability vs NEXTTEAM implied probabilities. If NFLTRADE says 60% chance of trade but sum of NEXTTEAM markets is only 30%, that's a mispricing.
4. SIGNAL STACKING: Multiple weak signals (speculation/developing) for the same player+team → combined stronger signal
5. NEGATIVE SIGNALS: Evidence deals collapsed, players less likely to move, situations that changed
6. TEAM NEEDS: For each team appearing in signals, note positions FILLED by recent signings and positions still NEEDED

Respond with JSON only.`;

  const userPrompt = `Provide your analysis as JSON with this structure:
{
  "player_updates": [
    {
      "player_name": "string",
      "movement_likelihood": 0-100,
      "likely_destination": "team name or null",
      "reasoning": "brief explanation",
      "current_team": "team name or null",
      "position": "QB/WR/RB/etc or null"
    }
  ],
  "team_updates": [
    {
      "team_name": "string",
      "positions_filled": ["WR", "CB"],
      "positions_needed": ["QB", "LB"],
      "cap_situation": "tight/moderate/flush",
      "reasoning": "brief explanation"
    }
  ],
  "arbitrage_alerts": [
    {
      "player_name": "string",
      "description": "NFLTRADE at 60¢ but NEXTTEAM sum only 30¢",
      "suggested_action": "buy YES on NEXTTEAM-X or sell NFLTRADE",
      "urgency": "high/medium/low"
    }
  ],
  "signal_stacks": [
    {
      "player_name": "string",
      "destination_team": "string",
      "combined_confidence": 0-100,
      "contributing_signals": 3,
      "event_type": "signing",
      "reasoning": "3 Tier 2 sources mention interest + team has cap space + positional need"
    }
  ],
  "second_order_effects": [
    {
      "trigger": "Player X signs with Team Y",
      "affected_player": "Player Z",
      "effect": "downgrade/upgrade",
      "reasoning": "Team Y no longer needs WR, Player Z was linked to them"
    }
  ]
}`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[DEEP] Groq API error (${response.status}): ${errText}`);
      return;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[DEEP] No content in Groq response");
      return;
    }

    const analysis = JSON.parse(content);
    console.log("[DEEP] Analysis received, processing...");

    // 6a. Process player updates
    for (const update of analysis.player_updates ?? []) {
      await updatePlayerContext(update);
    }

    // 6b. Process team updates
    for (const update of analysis.team_updates ?? []) {
      await updateTeamContext(update);
    }

    // 6c. Process arbitrage alerts
    for (const alert of analysis.arbitrage_alerts ?? []) {
      await processArbitrageAlert(alert);
    }

    // 6d. Process signal stacks
    for (const stack of analysis.signal_stacks ?? []) {
      await processSignalStack(stack);
    }

    // Log second-order effects
    for (const effect of analysis.second_order_effects ?? []) {
      console.log(`[DEEP] 2nd order: ${effect.trigger} → ${effect.affected_player} (${effect.effect}): ${effect.reasoning}`);
    }

    console.log(`[DEEP] Analysis complete: ${(analysis.player_updates ?? []).length} player updates, ` +
      `${(analysis.team_updates ?? []).length} team updates, ` +
      `${(analysis.arbitrage_alerts ?? []).length} arb alerts, ` +
      `${(analysis.signal_stacks ?? []).length} signal stacks`);

  } catch (e) {
    console.error("[DEEP] Error in deep analysis:", e);
  }
}

async function updatePlayerContext(update: {
  player_name: string;
  movement_likelihood: number;
  likely_destination: string | null;
  reasoning: string;
  current_team: string | null;
  position: string | null;
}): Promise<void> {
  const key = update.player_name.toLowerCase();

  const ctx: PlayerContext = playerContexts.get(key) ?? {
    playerName: update.player_name,
    signals: [],
    currentTeam: null,
    position: null,
    lastUpdated: 0,
  };

  // If movement_likelihood >= 90 and there's a destination, treat it as the current team (confirmed move)
  const effectiveTeam = (update.movement_likelihood >= 90 && update.likely_destination)
    ? update.likely_destination
    : update.current_team ?? ctx.currentTeam;
  ctx.currentTeam = effectiveTeam;
  ctx.position = update.position ?? ctx.position;
  ctx.lastUpdated = Date.now();

  playerContexts.set(key, ctx);

  // Upsert to nfl_context table
  try {
    const { error } = await supabase.from("nfl_context").upsert({
      entity_type: "player",
      entity_name: update.player_name,
      context_summary: update.reasoning,
      linked_entities: {
        likely_destination: update.likely_destination,
        previous_team: update.current_team,
        position: update.position,
        movement_likelihood: update.movement_likelihood,
      },
      updated_at: new Date().toISOString(),
      meta: {
        movement_likelihood: update.movement_likelihood,
        likely_destination: update.likely_destination,
        current_team: effectiveTeam,
        previous_team: update.current_team,
        position: update.position,
      },
    }, { onConflict: "entity_type,entity_name" });
    if (error) console.error(`[DEEP] Error upserting player context for ${update.player_name}:`, error);
  } catch (e) {
    console.error(`[DEEP] Error upserting player context for ${update.player_name}:`, e);
  }
}

async function updateTeamContext(update: {
  team_name: string;
  positions_filled: string[];
  positions_needed: string[];
  cap_situation: string;
  reasoning: string;
}): Promise<void> {
  const key = update.team_name.toLowerCase();

  const ctx: TeamContext = teamContexts.get(key) ?? {
    teamName: update.team_name,
    needs: [],
    capSpace: null,
    recentSignals: [],
    lastUpdated: 0,
  };

  ctx.needs = update.positions_needed;
  ctx.lastUpdated = Date.now();

  teamContexts.set(key, ctx);

  // Upsert to nfl_context table
  try {
    const { error } = await supabase.from("nfl_context").upsert({
      entity_type: "team",
      entity_name: update.team_name,
      context_summary: update.reasoning,
      positional_needs: {
        filled: update.positions_filled,
        needed: update.positions_needed,
        cap_situation: update.cap_situation,
      },
      updated_at: new Date().toISOString(),
      meta: {
        positions_filled: update.positions_filled,
        positions_needed: update.positions_needed,
        cap_situation: update.cap_situation,
      },
    }, { onConflict: "entity_type,entity_name" });
    if (error) console.error(`[DEEP] Error upserting team context for ${update.team_name}:`, error);
  } catch (e) {
    console.error(`[DEEP] Error upserting team context for ${update.team_name}:`, e);
  }
}

async function processArbitrageAlert(alert: {
  player_name: string;
  description: string;
  suggested_action: string;
  urgency: string;
}): Promise<void> {
  console.log(`[ARB] ${alert.urgency.toUpperCase()}: ${alert.player_name} — ${alert.description}`);

  // Log to nfl_arbitrage_events
  try {
    await supabase.from("nfl_arbitrage_events").insert({
      player_name: alert.player_name,
      description: alert.description,
      suggested_action: alert.suggested_action,
      urgency: alert.urgency,
      meta: { bot_id: BOT_ID, timestamp: new Date().toISOString() },
    });
  } catch (e) {
    console.error(`[ARB] Error logging arbitrage event:`, e);
  }

  // Send Telegram alert (notification only, no auto-trade on arb)
  const urgencyEmoji = alert.urgency === "high" ? "🔴" : alert.urgency === "medium" ? "🟡" : "🟢";
  await sendTelegram(
    `${urgencyEmoji} <b>ARBITRAGE ALERT</b>\n\n` +
    `Player: ${alert.player_name}\n` +
    `${alert.description}\n` +
    `Suggested: ${alert.suggested_action}\n` +
    `Urgency: ${alert.urgency.toUpperCase()}`
  );
}

async function processSignalStack(stack: {
  player_name: string;
  destination_team: string;
  combined_confidence: number;
  contributing_signals: number;
  event_type: string;
  reasoning: string;
}): Promise<void> {
  console.log(`[STACK] ${stack.player_name} → ${stack.destination_team}: confidence ${stack.combined_confidence}% (${stack.contributing_signals} signals)`);

  // Only create synthetic signal if combined confidence >= 50%
  if (stack.combined_confidence < 50) {
    console.log(`[STACK] Skipping: combined confidence ${stack.combined_confidence}% < 50% threshold`);
    return;
  }

  // Determine confidence tier from combined confidence
  let confidenceTier: ConfidenceTier;
  if (stack.combined_confidence >= 90) {
    confidenceTier = "confirmed";
  } else if (stack.combined_confidence >= 70) {
    confidenceTier = "strong_intel";
  } else if (stack.combined_confidence >= 50) {
    confidenceTier = "developing";
  } else {
    confidenceTier = "speculation";
  }

  // Create synthetic signal
  const syntheticSignal: Signal = {
    id: "",
    tweetId: `synthetic-stack-${Date.now()}`,
    tweetText: `[SIGNAL STACK] ${stack.contributing_signals} signals: ${stack.reasoning}`,
    sourceHandle: "deep-analysis",
    sourceTier: 1,
    playerName: stack.player_name,
    eventType: (stack.event_type as EventType) ?? "signing",
    confidenceTier,
    confidenceScore: stack.combined_confidence,
    destinationTeam: stack.destination_team,
    sentiment: stack.event_type === "cut" || stack.event_type === "release" ? "falling" : "rising",
    timestamp: Date.now(),
    fastPathMatch: false,
    llmClassification: {
      source: "signal_stack",
      combined_confidence: stack.combined_confidence,
      contributing_signals: stack.contributing_signals,
      reasoning: stack.reasoning,
    },
  };

  const saved = await saveSignal(syntheticSignal);
  await executeTradesForSignal(saved);

  await sendTelegram(
    `📊 <b>SIGNAL STACK TRIGGERED</b>\n\n` +
    `Player: ${stack.player_name}\n` +
    `Team: ${stack.destination_team}\n` +
    `Combined confidence: ${stack.combined_confidence}%\n` +
    `Signals: ${stack.contributing_signals}\n` +
    `Tier: ${confidenceTier}\n` +
    `Reasoning: ${stack.reasoning}`
  );
}

// =============================================================================
// TASK 10: STATE PERSISTENCE AND MAIN LOOP
// =============================================================================

async function saveState(): Promise<void> {
  try {
    // Serialize lastTweetIds Map → object
    const lastTweetIdsObj: Record<string, string> = {};
    for (const [handle, id] of lastTweetIds) {
      lastTweetIdsObj[handle] = id;
    }

    // Serialize tradedSignals — keep last 1000
    const tradedSignalsArr = Array.from(tradedSignals).slice(-1000);

    // Serialize overrides
    const overridesObj = {
      killedPlayers: Array.from(overrides.killedPlayers),
      maxPriceOverrides: Object.fromEntries(overrides.maxPriceOverrides),
      confidenceBoosts: Object.fromEntries(overrides.confidenceBoosts),
      positionSizeMultiplier: overrides.positionSizeMultiplier,
      teamNeedsOverrides: Object.fromEntries(
        Array.from(overrides.teamNeedsOverrides.entries()).map(([k, v]) => [k, v])
      ),
    };

    const { error } = await supabase.from("bot_status").upsert({
      id: BOT_ID,
      status: "running",
      last_poll_at: new Date().toISOString(),
      meta: {
        lastTweetIds: lastTweetIdsObj,
        tradedSignals: tradedSignalsArr,
        overrides: overridesObj,
        marketsTracked: allMarkets.size,
        signalsInBuffer: recentSignals.length,
        savedAt: new Date().toISOString(),
      },
    }, { onConflict: "id" });
    if (error) console.error("[STATE] Error saving state:", error);

    console.log(`[STATE] Saved: ${allMarkets.size} markets, ${tradedSignalsArr.length} traded signals, ${lastTweetIds.size} tweet cursors`);
  } catch (e) {
    console.error("[STATE] Error saving state:", e);
  }
}

async function loadState(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("bot_status")
      .select("*")
      .eq("id", BOT_ID)
      .single();

    if (error || !data) {
      console.log("[STATE] No previous state found, starting fresh");
      return;
    }

    const meta = data.meta;
    if (!meta) {
      console.log("[STATE] No meta in bot_status, starting fresh");
      return;
    }

    // Restore lastTweetIds
    if (meta.lastTweetIds && typeof meta.lastTweetIds === "object") {
      for (const [handle, id] of Object.entries(meta.lastTweetIds)) {
        if (typeof id === "string") {
          lastTweetIds.set(handle, id);
        }
      }
      console.log(`[STATE] Restored ${lastTweetIds.size} tweet cursors`);
    }

    // Restore tradedSignals
    if (Array.isArray(meta.tradedSignals)) {
      for (const key of meta.tradedSignals) {
        if (typeof key === "string") {
          tradedSignals.add(key);
        }
      }
      console.log(`[STATE] Restored ${tradedSignals.size} traded signal dedup keys`);
    }

    // Restore overrides
    if (meta.overrides) {
      const ov = meta.overrides;

      if (Array.isArray(ov.killedPlayers)) {
        for (const p of ov.killedPlayers) {
          if (typeof p === "string") overrides.killedPlayers.add(p);
        }
      }

      if (ov.maxPriceOverrides && typeof ov.maxPriceOverrides === "object") {
        for (const [ticker, price] of Object.entries(ov.maxPriceOverrides)) {
          if (typeof price === "number") overrides.maxPriceOverrides.set(ticker, price);
        }
      }

      if (ov.confidenceBoosts && typeof ov.confidenceBoosts === "object") {
        for (const [player, boost] of Object.entries(ov.confidenceBoosts)) {
          if (typeof boost === "number") overrides.confidenceBoosts.set(player, boost);
        }
      }

      if (typeof ov.positionSizeMultiplier === "number") {
        overrides.positionSizeMultiplier = ov.positionSizeMultiplier;
      }

      if (ov.teamNeedsOverrides && typeof ov.teamNeedsOverrides === "object") {
        for (const [team, needs] of Object.entries(ov.teamNeedsOverrides)) {
          if (Array.isArray(needs)) {
            overrides.teamNeedsOverrides.set(team, needs as string[]);
          }
        }
      }

      console.log(`[STATE] Restored overrides: ${overrides.killedPlayers.size} killed players, ` +
        `${overrides.maxPriceOverrides.size} price overrides, ` +
        `${overrides.confidenceBoosts.size} confidence boosts`);
    }

    console.log(`[STATE] State loaded from ${meta.savedAt ?? "unknown time"}`);
  } catch (e) {
    console.error("[STATE] Error loading state:", e);
  }
}

async function loadContext(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("nfl_context")
      .select("*");

    if (error) {
      console.error("[CONTEXT] Error loading context:", error);
      return;
    }

    if (!data || data.length === 0) {
      console.log("[CONTEXT] No existing context found");
      return;
    }

    let playerCount = 0;
    let teamCount = 0;

    for (const row of data) {
      const key = (row.entity_name ?? "").toLowerCase();
      if (row.entity_type === "player") {
        playerContexts.set(key, {
          playerName: row.entity_name ?? key,
          signals: [],
          currentTeam: row.meta?.current_team ?? row.linked_entities?.current_team ?? null,
          position: row.meta?.position ?? row.linked_entities?.position ?? null,
          lastUpdated: new Date(row.updated_at).getTime(),
        });
        playerCount++;
      } else if (row.entity_type === "team") {
        teamContexts.set(key, {
          teamName: row.entity_name ?? key,
          needs: row.meta?.positions_needed ?? row.positional_needs?.needed ?? [],
          capSpace: null,
          recentSignals: [],
          lastUpdated: new Date(row.updated_at).getTime(),
        });
        teamCount++;
      }
    }

    console.log(`[CONTEXT] Loaded ${playerCount} player contexts, ${teamCount} team contexts`);
  } catch (e) {
    console.error("[CONTEXT] Error loading context:", e);
  }
}

async function sendHeartbeat(): Promise<void> {
  try {
    const balance = await getBalance();
    const positions = await getPositions();

    const nflPositions = positions.filter(p =>
      p.ticker.includes("NFLTRADE") || p.ticker.includes("NEXTTEAMNFL")
    );

    const balanceStr = balance
      ? `$${(balance.balance / 100).toFixed(2)}`
      : "unknown";
    const portfolioStr = balance
      ? `$${(balance.portfolioValue / 100).toFixed(2)}`
      : "unknown";

    await sendTelegram(
      `💓 <b>NFL FA Bot Heartbeat</b>\n\n` +
      `Status: ${NFL_TRADING_DISABLED ? "MONITORING ONLY" : "ACTIVE"}\n` +
      `Balance: ${balanceStr}\n` +
      `Portfolio: ${portfolioStr}\n` +
      `NFL Positions: ${nflPositions.length}\n` +
      `Markets Tracked: ${allMarkets.size}\n` +
      `Players Tracked: ${playerMarkets.size}\n` +
      `Signals in Buffer: ${recentSignals.length}\n` +
      `Tweet Cursors: ${lastTweetIds.size}\n` +
      `Traded Signals: ${tradedSignals.size}`
    );
  } catch (e) {
    console.error("[HEARTBEAT] Error:", e);
  }
}

async function replayUntradedSignals(): Promise<void> {
  console.log("[REPLAY] Checking for untraded confirmed signals...");
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: signals, error } = await supabase
      .from("nfl_signals")
      .select("*")
      .gte("created_at", cutoff)
      .in("confidence_tier", ["confirmed", "strong_intel"])
      .order("created_at", { ascending: true });

    if (error || !signals || signals.length === 0) {
      console.log("[REPLAY] No confirmed signals to replay");
      return;
    }

    let replayed = 0;
    for (const s of signals) {
      const pm = findPlayerMarkets(s.player_name);
      if (!pm) continue;

      // Check if already traded (dedup key)
      const tradeKey = `${s.player_name.toLowerCase()}:${pm.tradeMarket?.ticker ?? ""}`;
      if (tradedSignals.has(tradeKey)) continue;

      // Build signal object
      const signal: Signal = {
        id: s.id,
        tweetId: s.meta?.tweet_id ?? "",
        tweetText: s.raw_text ?? "",
        sourceHandle: s.source_author ?? "",
        sourceTier: s.source_tier ?? 1,
        playerName: s.player_name,
        eventType: s.event_type as EventType,
        confidenceTier: s.confidence_tier as ConfidenceTier,
        confidenceScore: s.confidence_score ?? 0,
        destinationTeam: s.team,
        sentiment: s.event_type === "trade" || s.event_type === "signing" ? "rising" : "falling",
        timestamp: new Date(s.created_at).getTime(),
        fastPathMatch: false,
        llmClassification: s.llm_classification,
      };

      console.log(`[REPLAY] Replaying: ${signal.eventType} / ${signal.playerName} (${signal.confidenceTier})`);
      await executeTradesForSignal(signal);
      replayed++;
    }

    console.log(`[REPLAY] Done: ${replayed} signals replayed, ${signals.length} total checked`);
  } catch (e) {
    console.error("[REPLAY] Error:", e);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  NFL FREE AGENCY BOT — Starting Up");
  console.log(`  Trading: ${NFL_TRADING_DISABLED ? "DISABLED (monitoring only)" : "ENABLED"}`);
  console.log(`  Bot ID: ${BOT_ID}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log("=".repeat(60));

  // 1. Load persisted state
  await loadState();

  // 2. Refresh markets
  await refreshMarkets();

  // Debug: show player names in market map
  console.log(`[MARKETS] Player map (${playerMarkets.size} players):`);
  for (const [key, pm] of playerMarkets) {
    const hasTrade = pm.tradeMarket ? `TRADE=${pm.tradeMarket.ticker}` : "no-trade";
    const nextTeamCount = pm.nextTeamMarkets.size;
    console.log(`  ${key}: ${hasTrade}, ${nextTeamCount} next-team markets`);
  }

  // 3. Load context from Supabase
  await loadContext();

  // 3.5. Replay untraded confirmed signals from DB (catches signals from when trading was disabled)
  if (!NFL_TRADING_DISABLED) {
    await replayUntradedSignals();
  }

  // 4. Resolve Twitter user IDs
  await resolveUserIds();

  // 5. If context is empty, run initial deep analysis
  if (playerContexts.size === 0 && teamContexts.size === 0) {
    console.log("[MAIN] No context found, running initial deep analysis...");
    await runDeepAnalysis();
  }

  // 6. Start Twitter polling
  startTwitterPolling();

  // 7. Set up recurring intervals
  setInterval(refreshMarkets, MARKET_REFRESH_MS);
  setInterval(runDeepAnalysis, DEEP_ANALYSIS_INTERVAL_MS);
  setInterval(saveState, STATE_SAVE_INTERVAL_MS);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // 8. Send online notification
  await sendTelegram(
    `🟢 <b>NFL FA Bot Online</b>\n\n` +
    `Trading: ${NFL_TRADING_DISABLED ? "DISABLED" : "ENABLED"}\n` +
    `Markets: ${allMarkets.size}\n` +
    `Players: ${playerMarkets.size}\n` +
    `Twitter Sources: ${TWITTER_SOURCES.filter(s => s.userId).length}/${TWITTER_SOURCES.length}\n` +
    `Player Contexts: ${playerContexts.size}\n` +
    `Team Contexts: ${teamContexts.size}`
  );

  console.log("[MAIN] Bot is running. Press Ctrl+C to stop.");

  // 9. Keep alive
  await new Promise(() => {});
}

// =============================================================================
// ENTRY POINT
// =============================================================================

main().catch(async (err) => {
  console.error("[FATAL] Unhandled error:", err);
  try {
    await sendTelegram(
      `🔴 <b>NFL FA Bot CRASHED</b>\n\n` +
      `Error: ${String(err).substring(0, 500)}\n` +
      `Time: ${new Date().toISOString()}`
    );
  } catch (_) {
    // Telegram send failed, nothing we can do
  }
  Deno.exit(1);
});
