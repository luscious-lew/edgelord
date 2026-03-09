# NFL Free Agency & Trade Bot — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an automated Kalshi trading bot for NFL free agency and trade markets (KXNFLTRADE + KXNEXTTEAMNFL) with two-speed intelligence — instant reactive trading and a contextual analyst brain.

**Architecture:** Single Deno script (`nfl-fa-bot.ts`) monitors NFL insiders on Twitter/X, classifies signals via regex fast-path + Groq LLM, and executes aggressive single-shot trades on Kalshi. A background deep-analysis loop builds contextual understanding (team needs, signal stacking, positional logic). Next.js dashboard provides real-time monitoring and manual overrides. Full signal→trade audit chain in Supabase.

**Tech Stack:** Deno (bot runtime), Groq/Llama 3.3 70B (LLM), Supabase (Postgres + Realtime), Next.js + Tailwind (dashboard), Kalshi REST API, Twitter API v2

**Design doc:** `docs/plans/2026-03-09-nfl-fa-bot-design.md`

---

## Phase 1: Database Schema

### Task 1: Create NFL tables migration

**Files:**
- Create: `supabase/migrations/20260309000000_nfl_fa_tables.sql`

**Step 1: Write the migration**

```sql
-- NFL Free Agency & Trade Bot tables

-- Signal classifications from tweets
CREATE TABLE IF NOT EXISTS nfl_signals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  player_name text NOT NULL,
  team text,
  event_type text NOT NULL CHECK (event_type IN ('trade', 'signing', 'cut', 'release', 'extension', 'rumor', 'cap_move')),
  confidence_tier text NOT NULL CHECK (confidence_tier IN ('confirmed', 'strong_intel', 'developing', 'speculation')),
  confidence_score integer NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  source_author text NOT NULL,
  source_tier integer NOT NULL CHECK (source_tier BETWEEN 1 AND 3),
  raw_text text NOT NULL,
  llm_classification jsonb,
  language_pattern text,
  context_at_signal jsonb,
  created_at timestamptz DEFAULT now(),
  meta jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX idx_nfl_signals_player ON nfl_signals (player_name);
CREATE INDEX idx_nfl_signals_created ON nfl_signals (created_at DESC);
CREATE INDEX idx_nfl_signals_tier ON nfl_signals (confidence_tier);

-- Analyst brain context per player/team
CREATE TABLE IF NOT EXISTS nfl_context (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('player', 'team')),
  entity_name text NOT NULL,
  context_summary text,
  positional_needs jsonb DEFAULT '{}'::jsonb,
  linked_entities jsonb DEFAULT '{}'::jsonb,
  signal_count_48h integer DEFAULT 0,
  sentiment_trajectory text DEFAULT 'stable' CHECK (sentiment_trajectory IN ('rising', 'stable', 'falling', 'volatile')),
  last_deep_analysis_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  meta jsonb DEFAULT '{}'::jsonb,
  UNIQUE (entity_type, entity_name)
);

CREATE INDEX idx_nfl_context_entity ON nfl_context (entity_type, entity_name);

-- Trade execution records with full audit chain
CREATE TABLE IF NOT EXISTS nfl_trades (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_ids uuid[] DEFAULT '{}',
  primary_signal_id uuid REFERENCES nfl_signals(id),
  market_ticker text NOT NULL,
  market_type text NOT NULL CHECK (market_type IN ('nfltrade', 'nextteam')),
  side text NOT NULL CHECK (side IN ('yes', 'no')),
  action text NOT NULL CHECK (action IN ('buy', 'sell')),
  price_cents integer NOT NULL,
  quantity integer NOT NULL,
  confidence_tier_at_trade text,
  confidence_score_at_trade integer,
  context_snapshot jsonb,
  order_id text,
  fill_price_cents integer,
  status text DEFAULT 'placed' CHECK (status IN ('placed', 'filled', 'partial', 'cancelled', 'failed')),
  created_at timestamptz DEFAULT now(),
  meta jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX idx_nfl_trades_ticker ON nfl_trades (market_ticker);
CREATE INDEX idx_nfl_trades_created ON nfl_trades (created_at DESC);
CREATE INDEX idx_nfl_trades_signal ON nfl_trades (primary_signal_id);

-- Cross-market arbitrage detections
CREATE TABLE IF NOT EXISTS nfl_arbitrage_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  player_name text NOT NULL,
  arb_type text NOT NULL CHECK (arb_type IN ('trade_vs_nextteam', 'nextteam_overpriced')),
  details jsonb NOT NULL,
  action_taken text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_nfl_arb_created ON nfl_arbitrage_events (created_at DESC);

-- RLS policies (public read, service role write)
ALTER TABLE nfl_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfl_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfl_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfl_arbitrage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_nfl_signals" ON nfl_signals;
CREATE POLICY "public_read_nfl_signals" ON nfl_signals FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_nfl_context" ON nfl_context;
CREATE POLICY "public_read_nfl_context" ON nfl_context FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_nfl_trades" ON nfl_trades;
CREATE POLICY "public_read_nfl_trades" ON nfl_trades FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_nfl_arb" ON nfl_arbitrage_events;
CREATE POLICY "public_read_nfl_arb" ON nfl_arbitrage_events FOR SELECT USING (true);

DROP POLICY IF EXISTS "service_write_nfl_signals" ON nfl_signals;
CREATE POLICY "service_write_nfl_signals" ON nfl_signals FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_write_nfl_context" ON nfl_context;
CREATE POLICY "service_write_nfl_context" ON nfl_context FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_write_nfl_trades" ON nfl_trades;
CREATE POLICY "service_write_nfl_trades" ON nfl_trades FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_write_nfl_arb" ON nfl_arbitrage_events;
CREATE POLICY "service_write_nfl_arb" ON nfl_arbitrage_events FOR ALL USING (true) WITH CHECK (true);

-- Enable realtime for dashboard live updates
ALTER PUBLICATION supabase_realtime ADD TABLE nfl_signals;
ALTER PUBLICATION supabase_realtime ADD TABLE nfl_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE nfl_context;
```

**Step 2: Apply migration**

Run: `cd supabase && supabase db push` (or apply via Supabase dashboard SQL editor)

**Step 3: Commit**

```bash
git add supabase/migrations/20260309000000_nfl_fa_tables.sql
git commit -m "feat: add NFL FA bot database tables"
```

---

## Phase 2: Bot Core Infrastructure

### Task 2: Bot scaffold — environment, types, constants

**Files:**
- Create: `scripts/nfl-fa-bot.ts`

**Step 1: Write the bot scaffold with all types and constants**

Follow the exact pattern from `scripts/superbowl-ad-bot.ts` for Deno imports and env vars.

```typescript
import { createClient } from "npm:@supabase/supabase-js@2";

// ── Environment ──────────────────────────────────────────────
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
const NFL_TRADING_DISABLED = false; // Kill switch

// ── Trading Constants ────────────────────────────────────────
const MAX_SPEND_PER_TRADE_CENTS = 2500;
const MIN_CONTRACTS = 5;
const MAX_CONTRACTS = 100;
const MARKET_REFRESH_MS = 30_000;
const DEEP_ANALYSIS_INTERVAL_MS = 5 * 60 * 1000;
const STATE_SAVE_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

// ── Confidence → Trading Parameters ─────────────────────────
const CONFIDENCE_CONFIG = {
  confirmed:    { maxPrice: 95, sizeMultiplier: 1.0 },
  strong_intel: { maxPrice: 80, sizeMultiplier: 0.7 },
  developing:   { maxPrice: 55, sizeMultiplier: 0.4 },
  speculation:  { maxPrice: 0,  sizeMultiplier: 0 }, // no trade
} as const;

// ── Regex Fast-Path Patterns ─────────────────────────────────
// Ordered by specificity. If any matches, skip LLM for instant trade.
const FAST_PATH_PATTERNS: { pattern: RegExp; eventType: string; tier: string }[] = [
  { pattern: /has been traded to the (.+)/i,           eventType: "trade",   tier: "confirmed" },
  { pattern: /is being traded to the (.+)/i,           eventType: "trade",   tier: "confirmed" },
  { pattern: /trading .+ to the (.+)/i,                eventType: "trade",   tier: "confirmed" },
  { pattern: /has agreed to .+ deal with the (.+)/i,   eventType: "signing", tier: "confirmed" },
  { pattern: /is signing .+ deal with the (.+)/i,      eventType: "signing", tier: "confirmed" },
  { pattern: /has been released/i,                      eventType: "release", tier: "confirmed" },
  { pattern: /has been cut/i,                           eventType: "cut",     tier: "confirmed" },
  { pattern: /is signing.+extension/i,                  eventType: "extension", tier: "confirmed" },
];

// ── Twitter Source Tiers ─────────────────────────────────────
const TWITTER_SOURCES: { handle: string; userId: string; tier: 1 | 2 | 3 }[] = [
  // Tier 1 — 3 second polling
  { handle: "AdamSchefter",   userId: "", tier: 1 },
  { handle: "RapSheet",       userId: "", tier: 1 },
  { handle: "TomPelissero",   userId: "", tier: 1 },
  { handle: "JayGlazer",      userId: "", tier: 1 },
  // Tier 2 — 15 second polling
  { handle: "JosinaAnderson", userId: "", tier: 2 },
  { handle: "AlbertBreer",    userId: "", tier: 2 },
  { handle: "JordanSchultz",  userId: "", tier: 2 },
  { handle: "MikeGarafolo",   userId: "", tier: 2 },
  { handle: "DiannaBESPN",    userId: "", tier: 2 },
  { handle: "FieldYates",     userId: "", tier: 2 },
  // Tier 3 — 60 second polling
  { handle: "NFL",            userId: "", tier: 3 },
];

const TIER_POLL_MS = { 1: 3_000, 2: 15_000, 3: 60_000 } as const;

// ── Types ────────────────────────────────────────────────────
type ConfidenceTier = "confirmed" | "strong_intel" | "developing" | "speculation";
type EventType = "trade" | "signing" | "cut" | "release" | "extension" | "rumor" | "cap_move";
type MarketType = "nfltrade" | "nextteam";
type Sentiment = "rising" | "stable" | "falling" | "volatile";

interface NFLMarket {
  ticker: string;
  title: string;
  subtitle: string;
  yes_price: number;
  no_price: number;
  volume: number;
  open_interest: number;
  status: string;
  player_name: string;       // extracted from title
  team_name?: string;        // for NEXTTEAM markets only
  market_type: MarketType;
}

interface PlayerMap {
  tradeTicker?: string;                    // KXNFLTRADE ticker
  nextTeamTickers: Map<string, string>;    // team name → KXNEXTTEAMNFL ticker
  tradePrice?: number;                     // current NFLTRADE yes price
  nextTeamPrices: Map<string, number>;     // team name → NEXTTEAM yes price
}

interface Signal {
  id?: string;
  playerName: string;
  team?: string;
  eventType: EventType;
  confidenceTier: ConfidenceTier;
  confidenceScore: number;
  sourceAuthor: string;
  sourceTier: 1 | 2 | 3;
  rawText: string;
  llmClassification?: Record<string, unknown>;
  languagePattern?: string;
  contextAtSignal?: Record<string, unknown>;
  tweetId?: string;
}

interface PlayerContext {
  entityName: string;
  contextSummary: string;
  linkedTeams: Record<string, number>;  // team → strength score 0-100
  signalCount48h: number;
  sentiment: Sentiment;
  recentSignals: Signal[];
}

interface TeamContext {
  entityName: string;
  contextSummary: string;
  positionalNeeds: Record<string, string>;  // position → "filled"|"high_need"|"moderate_need"
  recentMoves: string[];
  signalCount48h: number;
}

// ── In-Memory State ──────────────────────────────────────────
const allMarkets: Map<string, NFLMarket> = new Map();
const playerMarkets: Map<string, PlayerMap> = new Map();        // playerName → markets
const playerContexts: Map<string, PlayerContext> = new Map();
const teamContexts: Map<string, TeamContext> = new Map();
const lastTweetIds: Map<string, string> = new Map();            // handle → last tweet ID
const tradedSignals: Set<string> = new Set();                   // dedup: signal IDs already traded on
const recentSignals: Signal[] = [];                             // rolling buffer for deep analysis

// Manual overrides (loaded from bot_status.meta)
let overrides: {
  killedPlayers: Set<string>;           // players blocked from trading
  maxPriceOverrides: Map<string, number>; // player → max price override
  confidenceBoosts: Map<string, number>;  // player → tier adjustment (-1, +1)
  positionSizeMultiplier: number;       // global multiplier
  teamNeedsOverrides: Map<string, Record<string, string>>; // team → {position → status}
} = {
  killedPlayers: new Set(),
  maxPriceOverrides: new Map(),
  confidenceBoosts: new Map(),
  positionSizeMultiplier: 1.0,
  teamNeedsOverrides: new Map(),
};

console.log("[NFL-FA-BOT] Scaffold loaded. Types and constants ready.");
```

**Step 2: Verify it loads**

Run: `cd scripts && deno check nfl-fa-bot.ts`

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot scaffold with types, constants, and state"
```

---

### Task 3: Kalshi auth + API helpers

**Files:**
- Modify: `scripts/nfl-fa-bot.ts`

**Step 1: Add Kalshi auth functions**

Copy the proven pattern from `scripts/nba-trade-bot-v2.ts` (the `pemToArrayBuffer` + `getKalshiHeaders` functions). Then add typed API helpers:

```typescript
// ── Kalshi Auth (proven pattern from NBA bot) ────────────────
function pemToArrayBuffer(pem: string): ArrayBuffer {
  // ... exact copy from nba-trade-bot-v2.ts
}

async function getKalshiHeaders(method: string, path: string): Promise<Headers> {
  // ... exact copy from nba-trade-bot-v2.ts
}

// ── Kalshi API Helpers ───────────────────────────────────────
async function kalshiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = await getKalshiHeaders(method, path);
  const resp = await fetch(`${KALSHI_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Kalshi ${method} ${path} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function placeOrder(
  ticker: string,
  side: "yes" | "no",
  priceCents: number,
  quantity: number,
  signal: Signal
): Promise<{ orderId: string; filled: boolean }> {
  if (NFL_TRADING_DISABLED) {
    console.log(`[KILL_SWITCH] Would place ${side} order on ${ticker} @ ${priceCents}c x${quantity}`);
    return { orderId: "disabled", filled: false };
  }

  const path = "/portfolio/orders";
  const body = {
    ticker,
    action: "buy",
    side,
    type: "limit",
    yes_price: side === "yes" ? priceCents : undefined,
    no_price: side === "no" ? priceCents : undefined,
    count: quantity,
  };

  try {
    const result = await kalshiFetch<{ order: { order_id: string; status: string } }>("POST", path, body);
    const orderId = result.order.order_id;
    const filled = result.order.status === "executed";
    console.log(`[ORDER] ${side.toUpperCase()} ${ticker} @ ${priceCents}c x${quantity} → ${result.order.status} (${orderId})`);

    // Log to Supabase
    await supabase.from("nfl_trades").insert({
      primary_signal_id: signal.id,
      signal_ids: signal.id ? [signal.id] : [],
      market_ticker: ticker,
      market_type: ticker.startsWith("KXNFLTRADE") ? "nfltrade" : "nextteam",
      side,
      action: "buy",
      price_cents: priceCents,
      quantity,
      confidence_tier_at_trade: signal.confidenceTier,
      confidence_score_at_trade: signal.confidenceScore,
      context_snapshot: {
        playerContexts: Object.fromEntries(playerContexts),
        marketPrice: allMarkets.get(ticker)?.yes_price,
      },
      order_id: orderId,
      status: filled ? "filled" : "placed",
      meta: {
        source_author: signal.sourceAuthor,
        source_tier: signal.sourceTier,
        language_pattern: signal.languagePattern,
        tweet_id: signal.tweetId,
      },
    });

    await sendTelegram(
      `🏈 ${filled ? "FILLED" : "PLACED"}: ${side.toUpperCase()} ${ticker}\n` +
      `Price: ${priceCents}c x${quantity}\n` +
      `Signal: ${signal.confidenceTier} (${signal.confidenceScore}%) from @${signal.sourceAuthor}\n` +
      `"${signal.rawText.substring(0, 200)}"`
    );

    return { orderId, filled };
  } catch (e) {
    console.error(`[ORDER_ERROR] ${ticker}:`, e);
    await sendTelegram(`❌ Order failed: ${ticker} ${side} @ ${priceCents}c — ${e}`);
    return { orderId: "", filled: false };
  }
}

async function getBalance(): Promise<{ balance: number; portfolioValue: number }> {
  const data = await kalshiFetch<{ balance: number; portfolio_value: number }>("GET", "/portfolio/balance");
  return { balance: data.balance, portfolioValue: data.portfolio_value };
}

async function getPositions(): Promise<Array<{ ticker: string; position: number; no_position: number; market_value: number }>> {
  const data = await kalshiFetch<{ market_positions: Array<Record<string, unknown>> }>(
    "GET", "/portfolio/positions?settlement_status=unsettled"
  );
  // CRITICAL: Handle position vs no_position separately (NBA bot bug fix)
  return (data.market_positions ?? []).map((p: Record<string, unknown>) => ({
    ticker: p.ticker as string,
    position: Number(p.position ?? 0),
    no_position: Number(p.no_position ?? 0),
    market_value: Number(p.market_value ?? 0),
  }));
}
```

**Step 2: Add Telegram helper**

```typescript
async function sendTelegram(msg: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("[TELEGRAM] Failed to send:", e);
  }
}
```

**Step 3: Verify**

Run: `deno check scripts/nfl-fa-bot.ts`

**Step 4: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot Kalshi auth, API helpers, and order execution"
```

---

### Task 4: Market discovery and player→ticker mapping

**Files:**
- Modify: `scripts/nfl-fa-bot.ts`

**Step 1: Add market fetching and player extraction**

```typescript
// ── Market Management ────────────────────────────────────────

function extractPlayerName(title: string, marketType: MarketType): string {
  // NFLTRADE titles: "Jermaine Johnson traded?" or "Will Jermaine Johnson be traded?"
  // NEXTTEAM titles: "Saquon Barkley's next team" or "Saquon Barkley: Next Team"
  let name = title;
  if (marketType === "nfltrade") {
    name = name.replace(/^Will\s+/i, "").replace(/\s+(be\s+)?traded\??$/i, "").trim();
  } else {
    name = name.replace(/'s\s+next\s+team.*$/i, "").replace(/:\s*Next\s+Team.*$/i, "").trim();
  }
  return name;
}

function extractTeamName(subtitle: string): string | undefined {
  // NEXTTEAM subtitles contain the team name, e.g. "Kansas City Chiefs"
  // This varies by market — extract from subtitle or title suffix
  if (!subtitle) return undefined;
  return subtitle.trim() || undefined;
}

async function refreshMarkets(): Promise<void> {
  try {
    // Fetch NFLTRADE markets
    const tradeData = await kalshiFetch<{ markets: Record<string, unknown>[] }>(
      "GET", "/markets?series_ticker=KXNFLTRADE&status=open&limit=200"
    );

    // Fetch NEXTTEAM NFL markets
    const nextTeamData = await kalshiFetch<{ markets: Record<string, unknown>[] }>(
      "GET", "/markets?series_ticker=KXNEXTTEAMNFL&status=open&limit=200"
    );

    allMarkets.clear();
    // Don't clear playerMarkets — merge to preserve state

    const processMarket = (m: Record<string, unknown>, type: MarketType) => {
      const ticker = m.ticker as string;
      const market: NFLMarket = {
        ticker,
        title: m.title as string ?? "",
        subtitle: m.subtitle as string ?? "",
        yes_price: Number(m.yes_price ?? m.last_price ?? 0),
        no_price: 100 - Number(m.yes_price ?? m.last_price ?? 0),
        volume: Number(m.volume ?? 0),
        open_interest: Number(m.open_interest ?? 0),
        status: m.status as string ?? "open",
        player_name: extractPlayerName(m.title as string ?? "", type),
        team_name: type === "nextteam" ? extractTeamName(m.subtitle as string ?? "") : undefined,
        market_type: type,
      };
      allMarkets.set(ticker, market);

      // Build player→market lookup
      const pName = market.player_name;
      if (!playerMarkets.has(pName)) {
        playerMarkets.set(pName, {
          nextTeamTickers: new Map(),
          nextTeamPrices: new Map(),
        });
      }
      const pm = playerMarkets.get(pName)!;
      if (type === "nfltrade") {
        pm.tradeTicker = ticker;
        pm.tradePrice = market.yes_price;
      } else if (market.team_name) {
        pm.nextTeamTickers.set(market.team_name, ticker);
        pm.nextTeamPrices.set(market.team_name, market.yes_price);
      }
    };

    for (const m of tradeData.markets ?? []) processMarket(m, "nfltrade");
    for (const m of nextTeamData.markets ?? []) processMarket(m, "nextteam");

    console.log(`[MARKETS] Refreshed: ${tradeData.markets?.length ?? 0} NFLTRADE, ${nextTeamData.markets?.length ?? 0} NEXTTEAM, ${playerMarkets.size} players`);
  } catch (e) {
    console.error("[MARKETS] Refresh failed:", e);
  }
}
```

**Step 2: Verify**

Run: `deno check scripts/nfl-fa-bot.ts`

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot market discovery and player-to-ticker mapping"
```

---

## Phase 3: Signal Ingestion

### Task 5: Twitter polling with tiered intervals

**Files:**
- Modify: `scripts/nfl-fa-bot.ts`

**Step 1: Add Twitter polling**

Follow the pattern from `nba-trade-bot-v2.ts` Twitter fetching but with per-tier timers.

```typescript
// ── Twitter Polling ──────────────────────────────────────────

async function fetchTweets(userId: string): Promise<Array<{ id: string; text: string; created_at: string }>> {
  const sinceId = lastTweetIds.get(userId);
  let url = `https://api.x.com/2/users/${userId}/tweets?max_results=5&tweet.fields=created_at`;
  if (sinceId) url += `&since_id=${sinceId}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
  });

  if (!resp.ok) {
    if (resp.status === 429) {
      console.warn(`[TWITTER] Rate limited on ${userId}`);
      return [];
    }
    console.error(`[TWITTER] Error ${resp.status} for ${userId}`);
    return [];
  }

  const data = await resp.json();
  const tweets = data.data ?? [];

  if (tweets.length > 0) {
    lastTweetIds.set(userId, tweets[0].id);
  }

  return tweets;
}

async function resolveUserIds(): Promise<void> {
  // Resolve handles to user IDs (needed for tweets endpoint)
  const handlesNeedingIds = TWITTER_SOURCES.filter(s => !s.userId);
  if (handlesNeedingIds.length === 0) return;

  const batchSize = 100;
  for (let i = 0; i < handlesNeedingIds.length; i += batchSize) {
    const batch = handlesNeedingIds.slice(i, i + batchSize);
    const usernames = batch.map(s => s.handle).join(",");
    const resp = await fetch(
      `https://api.x.com/2/users/by?usernames=${usernames}`,
      { headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` } }
    );
    if (!resp.ok) {
      console.error(`[TWITTER] Failed to resolve user IDs: ${resp.status}`);
      continue;
    }
    const data = await resp.json();
    for (const user of data.data ?? []) {
      const source = TWITTER_SOURCES.find(s => s.handle.toLowerCase() === user.username.toLowerCase());
      if (source) source.userId = user.id;
    }
  }
  console.log(`[TWITTER] Resolved ${TWITTER_SOURCES.filter(s => s.userId).length}/${TWITTER_SOURCES.length} user IDs`);
}

function startTwitterPolling(): void {
  for (const tierNum of [1, 2, 3] as const) {
    const sources = TWITTER_SOURCES.filter(s => s.tier === tierNum);
    const intervalMs = TIER_POLL_MS[tierNum];

    setInterval(async () => {
      for (const source of sources) {
        if (!source.userId) continue;
        try {
          const tweets = await fetchTweets(source.userId);
          for (const tweet of tweets) {
            await processTweet(tweet, source);
          }
        } catch (e) {
          console.error(`[TWITTER] Error polling @${source.handle}:`, e);
        }
      }
    }, intervalMs);

    console.log(`[TWITTER] Tier ${tierNum}: ${sources.length} sources @ ${intervalMs / 1000}s interval`);
  }
}
```

**Step 2: Add `processTweet` stub (filled in next task)**

```typescript
async function processTweet(
  tweet: { id: string; text: string; created_at: string },
  source: { handle: string; userId: string; tier: 1 | 2 | 3 }
): Promise<void> {
  console.log(`[TWEET] @${source.handle} (Tier ${source.tier}): ${tweet.text.substring(0, 100)}...`);
  // Will be implemented in Task 6 (fast-path) and Task 7 (LLM)
}
```

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot tiered Twitter polling"
```

---

### Task 6: Regex fast-path classification + instant trading

**Files:**
- Modify: `scripts/nfl-fa-bot.ts`

**Step 1: Implement processTweet with fast-path**

```typescript
async function processTweet(
  tweet: { id: string; text: string; created_at: string },
  source: { handle: string; userId: string; tier: 1 | 2 | 3 }
): Promise<void> {
  console.log(`[TWEET] @${source.handle} (T${source.tier}): ${tweet.text.substring(0, 120)}`);

  // Check for regex fast-path match
  const fastMatch = tryFastPath(tweet.text);

  if (fastMatch && source.tier <= 2) {
    // Fast path: place order IMMEDIATELY, run LLM in parallel to confirm
    console.log(`[FAST_PATH] Matched: ${fastMatch.languagePattern} → ${fastMatch.eventType} (${fastMatch.tier})`);

    const signal: Signal = {
      playerName: fastMatch.playerName ?? "",
      team: fastMatch.team,
      eventType: fastMatch.eventType as EventType,
      confidenceTier: fastMatch.tier as ConfidenceTier,
      confidenceScore: fastMatch.tier === "confirmed" ? 95 : 75,
      sourceAuthor: source.handle,
      sourceTier: source.tier,
      rawText: tweet.text,
      languagePattern: fastMatch.languagePattern,
      tweetId: tweet.id,
    };

    // Save signal + place orders + run LLM confirmation — all in parallel
    const [savedSignal] = await Promise.all([
      saveSignal(signal),
      executeTradesForSignal(signal),
      classifyWithLLM(tweet.text, source).then(llmResult => {
        // If LLM disagrees with fast-path, log warning but don't cancel
        // (order likely already filled on fast-moving markets)
        if (llmResult && llmResult.confidenceTier !== signal.confidenceTier) {
          console.warn(`[LLM_DISAGREE] Fast-path: ${signal.confidenceTier}, LLM: ${llmResult.confidenceTier}`);
          sendTelegram(`⚠️ LLM disagreed with fast-path on @${source.handle} tweet about ${signal.playerName}`);
        }
      }),
    ]);
  } else {
    // Standard path: LLM classifies first, then trade
    const llmResult = await classifyWithLLM(tweet.text, source);
    if (llmResult && llmResult.confidenceScore > 0) {
      const signal: Signal = {
        ...llmResult,
        sourceAuthor: source.handle,
        sourceTier: source.tier,
        rawText: tweet.text,
        tweetId: tweet.id,
      };
      await saveSignal(signal);
      await executeTradesForSignal(signal);
    }
  }
}

function tryFastPath(text: string): {
  eventType: string; tier: string; team?: string;
  playerName?: string; languagePattern: string;
} | null {
  for (const { pattern, eventType, tier } of FAST_PATH_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Extract team from capture group if present
      const team = match[1]?.replace(/^the\s+/i, "").replace(/[.,!]+$/, "").trim();

      // Try to extract player name (appears before the matched pattern)
      const beforeMatch = text.substring(0, text.search(pattern)).trim();
      // Player name is typically the last proper noun sequence before the pattern
      const playerName = extractPlayerFromContext(beforeMatch, text);

      return {
        eventType,
        tier,
        team: team || undefined,
        playerName,
        languagePattern: match[0],
      };
    }
  }
  return null;
}

function extractPlayerFromContext(beforeMatch: string, fullText: string): string | undefined {
  // Try to match against known player names in our market map
  for (const playerName of playerMarkets.keys()) {
    if (fullText.toLowerCase().includes(playerName.toLowerCase())) {
      return playerName;
    }
  }
  // Fallback: extract likely proper noun sequence
  const words = beforeMatch.split(/\s+/).filter(w => w.length > 0);
  // Take last 2-3 capitalized words as player name
  const nameWords: string[] = [];
  for (let i = words.length - 1; i >= 0 && nameWords.length < 3; i--) {
    if (/^[A-Z]/.test(words[i]) && !/^(The|A|An|And|For|To|In|Of|With|From|By|On|At|Is|Are|Was|Has|Will|Can|Sources?|Per|Via)$/i.test(words[i])) {
      nameWords.unshift(words[i].replace(/[^a-zA-Z.''-]/g, ""));
    } else break;
  }
  return nameWords.length >= 2 ? nameWords.join(" ") : undefined;
}
```

**Step 2: Add saveSignal helper**

```typescript
async function saveSignal(signal: Signal): Promise<Signal> {
  try {
    const { data, error } = await supabase.from("nfl_signals").insert({
      player_name: signal.playerName,
      team: signal.team,
      event_type: signal.eventType,
      confidence_tier: signal.confidenceTier,
      confidence_score: signal.confidenceScore,
      source_author: signal.sourceAuthor,
      source_tier: signal.sourceTier,
      raw_text: signal.rawText,
      llm_classification: signal.llmClassification,
      language_pattern: signal.languagePattern,
      context_at_signal: signal.contextAtSignal,
      meta: { tweet_id: signal.tweetId },
    }).select("id").single();

    if (error) throw error;
    signal.id = data.id;
    recentSignals.push(signal);
    // Trim rolling buffer to last 500 signals
    if (recentSignals.length > 500) recentSignals.splice(0, recentSignals.length - 500);
  } catch (e) {
    console.error("[SIGNAL_SAVE] Error:", e);
  }
  return signal;
}
```

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot regex fast-path and signal processing pipeline"
```

---

### Task 7: LLM classification via Groq

**Files:**
- Modify: `scripts/nfl-fa-bot.ts`

**Step 1: Add fast LLM classification**

```typescript
// ── LLM Classification (Groq / Llama 3.3 70B) ──────────────

async function classifyWithLLM(
  tweetText: string,
  source: { handle: string; tier: 1 | 2 | 3 }
): Promise<Signal | null> {
  const startMs = Date.now();

  // Gather minimal context for the fast path
  const mentionedPlayers = [...playerMarkets.keys()].filter(p =>
    tweetText.toLowerCase().includes(p.toLowerCase())
  );

  const prompt = `You are an NFL transaction classifier. Analyze this tweet and extract structured data.

TWEET by @${source.handle} (Reliability Tier ${source.tier}/3):
"${tweetText}"

KNOWN PLAYERS WITH ACTIVE MARKETS: ${mentionedPlayers.join(", ") || "none matched"}

RULES:
- "traded" = contractual rights transferred between NFL teams. Does NOT include: free agent signings, releases, cuts, waivers, draft picks.
- "signing" = player signs a new contract with a team (free agency or extension with new team).
- "cut"/"release" = player waived/released by current team.
- "extension" = player extends contract with CURRENT team (stays put).
- "rumor" = speculation without concrete deal language.
- "cap_move" = salary cap related move (restructure, cut for cap space).

LANGUAGE CONFIDENCE MAPPING:
- "has been traded to" / "is being traded to" / "trading X to" → confirmed (95-99)
- "has agreed to" / "is signing" → confirmed (93-99)
- "is finalizing" / "nearing a deal" → strong_intel (80-89)
- "is expected to" / "likely to" → strong_intel (70-79)
- "in serious discussions" / "engaged in talks" → developing (50-65)
- "has interest" / "exploring" / "could" / "target" → speculation (10-30)

OUTPUT exactly this JSON (no other text):
{
  "player_name": "Full Name" or null,
  "team": "Team Name" or null,
  "event_type": "trade"|"signing"|"cut"|"release"|"extension"|"rumor"|"cap_move",
  "confidence_tier": "confirmed"|"strong_intel"|"developing"|"speculation",
  "confidence_score": 0-100,
  "language_pattern": "exact quote from tweet that indicates the event",
  "reasoning": "brief explanation"
}`;

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) {
      console.error(`[LLM] Groq error ${resp.status}: ${await resp.text()}`);
      return null;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const latencyMs = Date.now() - startMs;
    console.log(`[LLM] Classified in ${latencyMs}ms: ${parsed.player_name} → ${parsed.event_type} (${parsed.confidence_tier}, ${parsed.confidence_score}%)`);

    if (!parsed.player_name || parsed.confidence_score === 0) return null;

    return {
      playerName: parsed.player_name,
      team: parsed.team,
      eventType: parsed.event_type,
      confidenceTier: parsed.confidence_tier,
      confidenceScore: parsed.confidence_score,
      sourceAuthor: source.handle,
      sourceTier: source.tier,
      rawText: tweetText,
      llmClassification: { ...parsed, latency_ms: latencyMs },
      languagePattern: parsed.language_pattern,
    };
  } catch (e) {
    console.error("[LLM] Classification failed:", e);
    return null;
  }
}
```

**Step 2: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot Groq LLM fast classification"
```

---

### Task 8: Trade execution logic — signal to orders

**Files:**
- Modify: `scripts/nfl-fa-bot.ts`

**Step 1: Implement executeTradesForSignal**

This is the core decision engine — given a classified signal, decide what orders to place.

```typescript
// ── Trade Execution Engine ───────────────────────────────────

async function executeTradesForSignal(signal: Signal): Promise<void> {
  if (NFL_TRADING_DISABLED) {
    console.log(`[KILL_SWITCH] Trading disabled. Signal: ${signal.playerName} ${signal.eventType} ${signal.confidenceTier}`);
    return;
  }

  // Check overrides
  if (overrides.killedPlayers.has(signal.playerName)) {
    console.log(`[OVERRIDE] Player ${signal.playerName} is blocked`);
    return;
  }

  // Skip speculation tier
  if (signal.confidenceTier === "speculation") {
    console.log(`[SKIP] Speculation tier — no trade for ${signal.playerName}`);
    return;
  }

  // Dedup: don't trade on same signal twice
  const dedupKey = `${signal.playerName}:${signal.eventType}:${signal.team ?? ""}:${signal.tweetId ?? Date.now()}`;
  if (tradedSignals.has(dedupKey)) {
    console.log(`[DEDUP] Already traded on this signal`);
    return;
  }
  tradedSignals.add(dedupKey);

  const pm = findPlayerMarkets(signal.playerName);
  if (!pm) {
    console.log(`[NO_MARKET] No markets found for ${signal.playerName}`);
    return;
  }

  // Apply confidence boost/nerf override
  let effectiveTier = signal.confidenceTier;
  const boost = overrides.confidenceBoosts.get(signal.playerName);
  if (boost) {
    const tiers: ConfidenceTier[] = ["speculation", "developing", "strong_intel", "confirmed"];
    const idx = tiers.indexOf(effectiveTier);
    const newIdx = Math.max(0, Math.min(tiers.length - 1, idx + boost));
    effectiveTier = tiers[newIdx];
  }

  const config = CONFIDENCE_CONFIG[effectiveTier];
  if (config.maxPrice === 0) return;

  const maxPrice = overrides.maxPriceOverrides.get(signal.playerName) ?? config.maxPrice;

  // Determine orders based on event type
  const orders: Array<{ ticker: string; side: "yes" | "no"; reason: string }> = [];

  switch (signal.eventType) {
    case "trade":
      // Buy YES on NFLTRADE (player is being traded)
      if (pm.tradeTicker) {
        orders.push({ ticker: pm.tradeTicker, side: "yes", reason: "trade confirmed" });
      }
      // Buy YES on NEXTTEAM for the destination team
      if (signal.team) {
        const nextTeamTicker = findNextTeamTicker(pm, signal.team);
        if (nextTeamTicker) {
          orders.push({ ticker: nextTeamTicker, side: "yes", reason: `trade to ${signal.team}` });
        }
      }
      break;

    case "signing":
      // Do NOT buy NFLTRADE (signing ≠ trade per Kalshi rules)
      // Buy YES on NEXTTEAM for the signing team
      if (signal.team) {
        const nextTeamTicker = findNextTeamTicker(pm, signal.team);
        if (nextTeamTicker) {
          orders.push({ ticker: nextTeamTicker, side: "yes", reason: `signing with ${signal.team}` });
        }
      }
      break;

    case "cut":
    case "release":
      // Player can't be "traded" anymore — consider NO on NFLTRADE
      if (pm.tradeTicker && (pm.tradePrice ?? 0) > 10) {
        orders.push({ ticker: pm.tradeTicker, side: "no", reason: `player ${signal.eventType} — can't be traded` });
      }
      break;

    case "extension":
      // Player staying with current team — NO on NFLTRADE
      if (pm.tradeTicker && (pm.tradePrice ?? 0) > 10) {
        orders.push({ ticker: pm.tradeTicker, side: "no", reason: "extension with current team" });
      }
      break;

    default:
      // rumor, cap_move — log but don't trade
      console.log(`[NO_ACTION] Event type ${signal.eventType} — no auto-trade`);
      return;
  }

  // Execute all orders in parallel
  if (orders.length > 0) {
    await Promise.all(orders.map(async (order) => {
      const market = allMarkets.get(order.ticker);
      const currentPrice = market?.yes_price ?? 50;

      // For YES: bid at maxPrice (fills at best available ask)
      // For NO: bid at min(maxPrice, 100 - currentYesPrice + 5)
      let bidPrice: number;
      if (order.side === "yes") {
        bidPrice = maxPrice;
      } else {
        bidPrice = Math.min(maxPrice, 100 - currentPrice + 5);
      }

      // Skip if market already at/above our max (no profit potential)
      if (order.side === "yes" && currentPrice >= 98) {
        console.log(`[SKIP] ${order.ticker} already at ${currentPrice}c — no edge`);
        return;
      }

      const quantity = calculateQuantity(bidPrice, config.sizeMultiplier);
      console.log(`[EXECUTE] ${order.side.toUpperCase()} ${order.ticker} @ ${bidPrice}c x${quantity} — ${order.reason}`);
      await placeOrder(order.ticker, order.side, bidPrice, quantity, signal);
    }));
  }
}

function findPlayerMarkets(playerName: string): PlayerMap | undefined {
  // Exact match first
  if (playerMarkets.has(playerName)) return playerMarkets.get(playerName);
  // Case-insensitive fuzzy match
  for (const [name, pm] of playerMarkets) {
    if (name.toLowerCase() === playerName.toLowerCase()) return pm;
  }
  // Partial match (last name)
  const lastName = playerName.split(" ").pop()?.toLowerCase();
  if (lastName) {
    for (const [name, pm] of playerMarkets) {
      if (name.toLowerCase().endsWith(lastName)) return pm;
    }
  }
  return undefined;
}

function findNextTeamTicker(pm: PlayerMap, teamName: string): string | undefined {
  // Exact match
  if (pm.nextTeamTickers.has(teamName)) return pm.nextTeamTickers.get(teamName);
  // Case-insensitive
  const lower = teamName.toLowerCase();
  for (const [team, ticker] of pm.nextTeamTickers) {
    if (team.toLowerCase() === lower) return ticker;
    // Partial match: "Chiefs" matches "Kansas City Chiefs"
    if (team.toLowerCase().includes(lower) || lower.includes(team.toLowerCase())) return ticker;
  }
  return undefined;
}

function calculateQuantity(priceCents: number, sizeMultiplier: number): number {
  const adjustedBudget = MAX_SPEND_PER_TRADE_CENTS * sizeMultiplier * overrides.positionSizeMultiplier;
  const qty = Math.floor(adjustedBudget / priceCents);
  return Math.max(MIN_CONTRACTS, Math.min(MAX_CONTRACTS, qty));
}
```

**Step 2: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot trade execution engine with event-type routing"
```

---

## Phase 4: Analyst Brain (System 2)

### Task 9: Deep analysis loop

**Files:**
- Modify: `scripts/nfl-fa-bot.ts`

**Step 1: Add deep analysis function**

```typescript
// ── Deep Analysis (System 2 — Analyst Brain) ─────────────────

async function runDeepAnalysis(): Promise<void> {
  const startMs = Date.now();
  console.log("[DEEP_ANALYSIS] Starting cycle...");

  // Gather recent signals (last 48h)
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: dbSignals } = await supabase
    .from("nfl_signals")
    .select("*")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(200);

  // Build context summaries per player and team
  const playerSignalMap = new Map<string, Array<Record<string, unknown>>>();
  const teamSignalMap = new Map<string, Array<Record<string, unknown>>>();

  for (const s of dbSignals ?? []) {
    if (!playerSignalMap.has(s.player_name)) playerSignalMap.set(s.player_name, []);
    playerSignalMap.get(s.player_name)!.push(s);
    if (s.team) {
      if (!teamSignalMap.has(s.team)) teamSignalMap.set(s.team, []);
      teamSignalMap.get(s.team)!.push(s);
    }
  }

  // Build market price context
  const marketContext: string[] = [];
  for (const [player, pm] of playerMarkets) {
    const signals = playerSignalMap.get(player) ?? [];
    const tradePrice = pm.tradePrice ?? 0;
    const topTeams = [...pm.nextTeamPrices.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, p]) => `${t}: ${p}c`)
      .join(", ");
    marketContext.push(
      `${player}: TRADE=${tradePrice}c, NEXTTEAM=[${topTeams}], signals_48h=${signals.length}`
    );
  }

  // Deep analysis LLM prompt
  const recentSignalSummary = (dbSignals ?? []).slice(0, 50).map(s =>
    `[${s.created_at}] @${s.source_author}: ${s.player_name} — ${s.event_type} (${s.confidence_tier}) "${s.raw_text?.substring(0, 100)}"`
  ).join("\n");

  const prompt = `You are a top-tier NFL analyst brain. You have been monitoring NFL free agency and trades continuously. Analyze the current landscape and provide updated assessments.

CURRENT MARKET PRICES:
${marketContext.join("\n")}

RECENT SIGNALS (last 48h, newest first):
${recentSignalSummary}

ANALYSIS TASKS:
1. For each player with active signals, assess the CURRENT likelihood of movement and to which team.
2. Identify SECOND-ORDER EFFECTS: if Team A just signed a WR, other WRs linked to Team A should be downgraded.
3. Identify CROSS-MARKET MISPRICINGS: where NFLTRADE price doesn't match the implied probability from NEXTTEAM outcomes.
4. Flag any SIGNAL STACKING: multiple independent weak signals pointing to the same outcome that together suggest higher confidence.
5. Identify NEGATIVE signals: deal collapses, players who are now LESS likely to move than the market implies.

For each team mentioned, note which positions they've FILLED recently and which remain OPEN needs.

OUTPUT as JSON:
{
  "player_updates": [
    {
      "player_name": "Name",
      "sentiment": "rising"|"stable"|"falling"|"volatile",
      "likely_destination": "Team" or null,
      "destination_confidence": 0-100,
      "trade_vs_signing": "trade"|"signing"|"unclear",
      "reasoning": "brief"
    }
  ],
  "team_updates": [
    {
      "team_name": "Name",
      "positions_filled": {"WR": "Player signed", ...},
      "positions_needed": ["CB", "OL", ...],
      "active_pursuits": "brief summary"
    }
  ],
  "arbitrage_alerts": [
    {
      "player_name": "Name",
      "type": "trade_vs_nextteam"|"nextteam_overpriced",
      "detail": "description of mismatch",
      "suggested_action": "buy/sell what"
    }
  ],
  "signal_stacking_alerts": [
    {
      "player_name": "Name",
      "team": "Team",
      "combined_confidence": 0-100,
      "signals_combined": ["brief description of each"],
      "suggested_action": "description"
    }
  ]
}`;

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) {
      console.error(`[DEEP_ANALYSIS] Groq error: ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const analysis = JSON.parse(data.choices[0].message.content);
    const latencyMs = Date.now() - startMs;
    console.log(`[DEEP_ANALYSIS] Completed in ${latencyMs}ms`);

    // Update player contexts
    for (const update of analysis.player_updates ?? []) {
      await updatePlayerContext(update);
    }

    // Update team contexts
    for (const update of analysis.team_updates ?? []) {
      await updateTeamContext(update);
    }

    // Process arbitrage alerts
    for (const alert of analysis.arbitrage_alerts ?? []) {
      await processArbitrageAlert(alert);
    }

    // Process signal stacking
    for (const stack of analysis.signal_stacking_alerts ?? []) {
      await processSignalStack(stack);
    }
  } catch (e) {
    console.error("[DEEP_ANALYSIS] Failed:", e);
  }
}

async function updatePlayerContext(update: Record<string, unknown>): Promise<void> {
  const name = update.player_name as string;
  const ctx: PlayerContext = {
    entityName: name,
    contextSummary: update.reasoning as string ?? "",
    linkedTeams: update.likely_destination
      ? { [update.likely_destination as string]: update.destination_confidence as number ?? 50 }
      : {},
    signalCount48h: 0,
    sentiment: update.sentiment as Sentiment ?? "stable",
    recentSignals: [],
  };
  playerContexts.set(name, ctx);

  // Persist to Supabase
  await supabase.from("nfl_context").upsert({
    entity_type: "player",
    entity_name: name,
    context_summary: ctx.contextSummary,
    linked_entities: ctx.linkedTeams,
    sentiment_trajectory: ctx.sentiment,
    last_deep_analysis_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    meta: { trade_vs_signing: update.trade_vs_signing },
  }, { onConflict: "entity_type,entity_name" });
}

async function updateTeamContext(update: Record<string, unknown>): Promise<void> {
  const name = update.team_name as string;
  const positionsFilled = update.positions_filled as Record<string, string> ?? {};
  const positionsNeeded = update.positions_needed as string[] ?? [];

  const needs: Record<string, string> = {};
  for (const pos of positionsNeeded) needs[pos] = "high_need";
  for (const pos of Object.keys(positionsFilled)) needs[pos] = "filled";

  // Apply manual overrides
  const manualOverrides = overrides.teamNeedsOverrides.get(name);
  if (manualOverrides) Object.assign(needs, manualOverrides);

  const ctx: TeamContext = {
    entityName: name,
    contextSummary: update.active_pursuits as string ?? "",
    positionalNeeds: needs,
    recentMoves: Object.entries(positionsFilled).map(([pos, detail]) => `${pos}: ${detail}`),
    signalCount48h: 0,
  };
  teamContexts.set(name, ctx);

  await supabase.from("nfl_context").upsert({
    entity_type: "team",
    entity_name: name,
    context_summary: ctx.contextSummary,
    positional_needs: needs,
    last_deep_analysis_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    meta: { recent_moves: ctx.recentMoves },
  }, { onConflict: "entity_type,entity_name" });
}

async function processArbitrageAlert(alert: Record<string, unknown>): Promise<void> {
  console.log(`[ARBITRAGE] ${alert.player_name}: ${alert.detail}`);

  await supabase.from("nfl_arbitrage_events").insert({
    player_name: alert.player_name,
    arb_type: alert.type,
    details: alert,
    action_taken: alert.suggested_action,
  });

  await sendTelegram(
    `📊 Arbitrage detected: ${alert.player_name}\n${alert.detail}\nSuggested: ${alert.suggested_action}`
  );

  // TODO: Auto-trade on arbitrage (conservative — notify only for now)
}

async function processSignalStack(stack: Record<string, unknown>): Promise<void> {
  const combinedConfidence = stack.combined_confidence as number ?? 0;
  if (combinedConfidence < 50) return; // Below developing threshold

  console.log(`[SIGNAL_STACK] ${stack.player_name} → ${stack.team}: ${combinedConfidence}% (stacked)`);

  // Create a synthetic signal from stacked intelligence
  const signal: Signal = {
    playerName: stack.player_name as string,
    team: stack.team as string,
    eventType: "rumor",
    confidenceTier: combinedConfidence >= 75 ? "strong_intel" : "developing",
    confidenceScore: combinedConfidence,
    sourceAuthor: "analyst_brain",
    sourceTier: 1, // Treat analyst brain as high reliability
    rawText: `[STACKED] ${(stack.signals_combined as string[])?.join(" + ") ?? "multiple signals"}`,
    languagePattern: "signal_stacking",
  };

  await saveSignal(signal);
  await executeTradesForSignal(signal);
}
```

**Step 2: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot deep analysis loop — analyst brain System 2"
```

---

## Phase 5: State Persistence & Main Loop

### Task 10: Bot state persistence and main orchestration

**Files:**
- Modify: `scripts/nfl-fa-bot.ts`

**Step 1: Add state save/load and main loop**

```typescript
// ── State Persistence ────────────────────────────────────────

async function saveState(): Promise<void> {
  try {
    await supabase.from("bot_status").upsert({
      id: BOT_ID,
      last_poll_at: new Date().toISOString(),
      status: NFL_TRADING_DISABLED ? "paused" : "running",
      meta: {
        lastTweetIds: Object.fromEntries(lastTweetIds),
        tradedSignals: [...tradedSignals].slice(-1000), // Keep last 1000
        overrides: {
          killedPlayers: [...overrides.killedPlayers],
          maxPriceOverrides: Object.fromEntries(overrides.maxPriceOverrides),
          confidenceBoosts: Object.fromEntries(overrides.confidenceBoosts),
          positionSizeMultiplier: overrides.positionSizeMultiplier,
          teamNeedsOverrides: Object.fromEntries(
            [...overrides.teamNeedsOverrides.entries()].map(([k, v]) => [k, v])
          ),
        },
        marketsTracked: playerMarkets.size,
        signalsInBuffer: recentSignals.length,
      },
    }, { onConflict: "id" });
  } catch (e) {
    console.error("[STATE_SAVE] Error:", e);
  }
}

async function loadState(): Promise<void> {
  try {
    const { data } = await supabase
      .from("bot_status")
      .select("meta")
      .eq("id", BOT_ID)
      .single();

    if (data?.meta) {
      const meta = data.meta;

      // Restore tweet cursors
      if (meta.lastTweetIds) {
        for (const [k, v] of Object.entries(meta.lastTweetIds)) {
          lastTweetIds.set(k, v as string);
        }
      }

      // Restore traded signals dedup
      if (meta.tradedSignals) {
        for (const s of meta.tradedSignals) tradedSignals.add(s as string);
      }

      // Restore overrides
      if (meta.overrides) {
        const o = meta.overrides;
        if (o.killedPlayers) overrides.killedPlayers = new Set(o.killedPlayers);
        if (o.maxPriceOverrides) overrides.maxPriceOverrides = new Map(Object.entries(o.maxPriceOverrides));
        if (o.confidenceBoosts) overrides.confidenceBoosts = new Map(Object.entries(o.confidenceBoosts));
        if (o.positionSizeMultiplier != null) overrides.positionSizeMultiplier = o.positionSizeMultiplier;
        if (o.teamNeedsOverrides) {
          overrides.teamNeedsOverrides = new Map(Object.entries(o.teamNeedsOverrides));
        }
      }

      console.log(`[STATE] Restored: ${lastTweetIds.size} cursors, ${tradedSignals.size} traded signals, ${overrides.killedPlayers.size} blocked players`);
    }
  } catch (e) {
    console.error("[STATE_LOAD] Error (starting fresh):", e);
  }
}

// Load persisted context from DB
async function loadContext(): Promise<void> {
  const { data } = await supabase.from("nfl_context").select("*");
  for (const row of data ?? []) {
    if (row.entity_type === "player") {
      playerContexts.set(row.entity_name, {
        entityName: row.entity_name,
        contextSummary: row.context_summary ?? "",
        linkedTeams: row.linked_entities ?? {},
        signalCount48h: row.signal_count_48h ?? 0,
        sentiment: row.sentiment_trajectory ?? "stable",
        recentSignals: [],
      });
    } else if (row.entity_type === "team") {
      teamContexts.set(row.entity_name, {
        entityName: row.entity_name,
        contextSummary: row.context_summary ?? "",
        positionalNeeds: row.positional_needs ?? {},
        recentMoves: row.meta?.recent_moves ?? [],
        signalCount48h: row.signal_count_48h ?? 0,
      });
    }
  }
  console.log(`[CONTEXT] Loaded: ${playerContexts.size} players, ${teamContexts.size} teams`);
}

// ── Heartbeat ────────────────────────────────────────────────

async function sendHeartbeat(): Promise<void> {
  const balance = await getBalance();
  const positions = await getPositions();
  const activePositions = positions.filter(p => p.position > 0 || p.no_position > 0);

  await sendTelegram(
    `💚 NFL FA Bot heartbeat\n` +
    `Status: ${NFL_TRADING_DISABLED ? "PAUSED" : "RUNNING"}\n` +
    `Balance: $${(balance.balance / 100).toFixed(2)}\n` +
    `Portfolio: $${(balance.portfolioValue / 100).toFixed(2)}\n` +
    `Active positions: ${activePositions.length}\n` +
    `Markets tracked: ${playerMarkets.size} players\n` +
    `Signals (48h buffer): ${recentSignals.length}`
  );
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("[NFL-FA-BOT] Starting up...");
  console.log(`[NFL-FA-BOT] Trading ${NFL_TRADING_DISABLED ? "DISABLED" : "ENABLED"}`);
  console.log("=".repeat(60));

  // 1. Load persisted state
  await loadState();

  // 2. Fetch all markets and build player map
  await refreshMarkets();

  // 3. Load persisted context (analyst brain memory)
  await loadContext();

  // 4. Resolve Twitter user IDs
  await resolveUserIds();

  // 5. Seed context if stale
  const staleThreshold = 6 * 60 * 60 * 1000;
  const anyStale = [...playerContexts.values()].length === 0;
  if (anyStale) {
    console.log("[INIT] Context is empty/stale — running initial deep analysis...");
    await runDeepAnalysis();
  }

  // 6. Start polling loops
  startTwitterPolling();

  // Market refresh every 30s
  setInterval(refreshMarkets, MARKET_REFRESH_MS);

  // Deep analysis every 5 min
  setInterval(runDeepAnalysis, DEEP_ANALYSIS_INTERVAL_MS);

  // State save every 60s
  setInterval(saveState, STATE_SAVE_INTERVAL_MS);

  // Heartbeat every 15 min
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // 7. Send startup notification
  await sendTelegram(
    `🏈 NFL FA Bot ONLINE\n` +
    `Trading: ${NFL_TRADING_DISABLED ? "DISABLED" : "ENABLED"}\n` +
    `Markets: ${playerMarkets.size} players tracked\n` +
    `Context: ${playerContexts.size} players, ${teamContexts.size} teams loaded`
  );

  console.log("[NFL-FA-BOT] All systems go. Monitoring...");

  // Keep alive
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("[FATAL]", e);
  sendTelegram(`🔴 NFL FA Bot CRASHED: ${e}`);
  Deno.exit(1);
});
```

**Step 2: Full verification**

Run: `deno check scripts/nfl-fa-bot.ts`

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: NFL FA bot main loop, state persistence, and heartbeat"
```

---

## Phase 6: Dashboard API Routes

### Task 11: NFL API routes

**Files:**
- Create: `src/app/api/nfl/status/route.ts`
- Create: `src/app/api/nfl/players/route.ts`
- Create: `src/app/api/nfl/signals/route.ts`
- Create: `src/app/api/nfl/trades/route.ts`
- Create: `src/app/api/nfl/teams/route.ts`
- Create: `src/app/api/nfl/arbitrage/route.ts`
- Create: `src/app/api/nfl/override/route.ts`

**Step 1: Create status route**

Follow the existing pattern from `src/app/api/positions/route.ts` — duplicate Kalshi auth inline (matching project convention).

```typescript
// src/app/api/nfl/status/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Kalshi auth — same inline pattern as other routes
const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID ?? "";
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY ?? "";

function pemToArrayBuffer(pem: string): ArrayBuffer {
  // ... exact copy from existing routes
}

async function getKalshiHeaders(method: string, path: string): Promise<Headers> {
  // ... exact copy from existing routes
}

export async function GET() {
  try {
    // Bot status from Supabase
    const { data: botStatus } = await supabase
      .from("bot_status")
      .select("*")
      .eq("id", "nfl-fa-bot")
      .single();

    // Kalshi balance
    const path = "/portfolio/balance";
    const headers = await getKalshiHeaders("GET", path);
    const balResp = await fetch(`https://api.elections.kalshi.com/trade-api/v2${path}`, { headers });
    const balance = await balResp.json();

    // Active positions count
    const posPath = "/portfolio/positions?settlement_status=unsettled";
    const posHeaders = await getKalshiHeaders("GET", posPath.split("?")[0]);
    const posResp = await fetch(`https://api.elections.kalshi.com/trade-api/v2${posPath}`, { headers: posHeaders });
    const positions = await posResp.json();

    // Trade P&L from nfl_trades
    const { data: trades } = await supabase
      .from("nfl_trades")
      .select("fill_price_cents, price_cents, quantity, side, status")
      .eq("status", "filled");

    return NextResponse.json({
      bot: botStatus,
      balance: balance.balance,
      portfolioValue: balance.portfolio_value,
      activePositions: (positions.market_positions ?? []).length,
      totalTrades: trades?.length ?? 0,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

**Step 2: Create players route**

```typescript
// src/app/api/nfl/players/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  try {
    const { data: contexts } = await supabase
      .from("nfl_context")
      .select("*")
      .eq("entity_type", "player")
      .order("updated_at", { ascending: false });

    // Get recent signals per player
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: signals } = await supabase
      .from("nfl_signals")
      .select("*")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false });

    // Get active trades per player
    const { data: trades } = await supabase
      .from("nfl_trades")
      .select("*")
      .in("status", ["placed", "filled"])
      .order("created_at", { ascending: false });

    // Group by player
    const playerMap = new Map<string, Record<string, unknown>>();
    for (const ctx of contexts ?? []) {
      playerMap.set(ctx.entity_name, {
        ...ctx,
        signals: [],
        trades: [],
      });
    }

    for (const s of signals ?? []) {
      const p = playerMap.get(s.player_name);
      if (p) (p.signals as unknown[]).push(s);
    }

    for (const t of trades ?? []) {
      // Match trade to player via market ticker (best effort)
      for (const [name, p] of playerMap) {
        if (t.market_ticker?.toLowerCase().includes(name.toLowerCase().replace(/\s+/g, "").substring(0, 8))) {
          (p.trades as unknown[]).push(t);
          break;
        }
      }
    }

    return NextResponse.json([...playerMap.values()]);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

**Step 3: Create signals, trades, teams, arbitrage routes (same pattern)**

Each route queries the corresponding Supabase table with appropriate filters and sorting. Follow the same `createClient` inline pattern.

- `signals/route.ts`: Query `nfl_signals` with pagination (`?limit=50&offset=0&player=X&tier=confirmed`)
- `trades/route.ts`: Query `nfl_trades` with joins to `nfl_signals` for audit trail
- `teams/route.ts`: Query `nfl_context` where `entity_type = 'team'`
- `arbitrage/route.ts`: Query `nfl_arbitrage_events` ordered by `created_at DESC`

**Step 4: Create override route (POST)**

```typescript
// src/app/api/nfl/override/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    // body: { type: "kill_player"|"max_price"|"confidence_boost"|"size_multiplier"|"team_needs", ... }

    // Load current bot status
    const { data: current } = await supabase
      .from("bot_status")
      .select("meta")
      .eq("id", "nfl-fa-bot")
      .single();

    const meta = current?.meta ?? {};
    const overrides = meta.overrides ?? {};

    switch (body.type) {
      case "kill_player":
        overrides.killedPlayers = overrides.killedPlayers ?? [];
        if (body.action === "add") overrides.killedPlayers.push(body.player);
        else overrides.killedPlayers = overrides.killedPlayers.filter((p: string) => p !== body.player);
        break;
      case "max_price":
        overrides.maxPriceOverrides = overrides.maxPriceOverrides ?? {};
        overrides.maxPriceOverrides[body.player] = body.value;
        break;
      case "confidence_boost":
        overrides.confidenceBoosts = overrides.confidenceBoosts ?? {};
        overrides.confidenceBoosts[body.player] = body.value; // -1, 0, +1
        break;
      case "size_multiplier":
        overrides.positionSizeMultiplier = body.value;
        break;
      case "team_needs":
        overrides.teamNeedsOverrides = overrides.teamNeedsOverrides ?? {};
        overrides.teamNeedsOverrides[body.team] = body.needs;
        break;
      case "kill_switch":
        meta.kill_switch = body.value; // true/false
        break;
    }

    meta.overrides = overrides;

    await supabase
      .from("bot_status")
      .upsert({ id: "nfl-fa-bot", meta }, { onConflict: "id" });

    return NextResponse.json({ success: true, overrides });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

**Step 5: Commit**

```bash
git add src/app/api/nfl/
git commit -m "feat: NFL FA dashboard API routes"
```

---

## Phase 7: Dashboard UI

### Task 12: Add NFL FA nav item to AppShell

**Files:**
- Modify: `src/components/layout/AppShell.tsx`

**Step 1:** Add `{ href: "/nfl-fa", label: "NFL FA", emoji: "🏈" }` to the nav items array, following the existing pattern for NBA trades and Super Bowl ads.

**Step 2: Commit**

```bash
git add src/components/layout/AppShell.tsx
git commit -m "feat: add NFL FA nav item"
```

---

### Task 13: NFL FA dashboard page — player cards + signal feed

**Files:**
- Create: `src/app/nfl-fa/page.tsx`

**Step 1: Build the dashboard page**

Follow the pattern from `src/app/superbowl-ads/page.tsx` — client component with polling.

The page should include:
1. **Top bar**: Bot status badge (live/paused), kill switch toggle, balance/P&L, active positions count
2. **Player cards grid**: Each card shows player name, position, NFLTRADE price with color coding, top 3 NEXTTEAM outcomes, sentiment indicator, signal count badge, latest signal preview, unrealized P&L if position held. Cards sorted by most recent signal. Clicking expands to full detail view.
3. **Signal feed sidebar**: Live-updating list of recent signals, color-coded by confidence tier (green=confirmed, yellow=strong_intel, blue=developing, gray=speculation). Each entry shows: time, source handle, player, classification, action taken.
4. **Expanded player view** (modal or inline expand): Full signal timeline, context summary from analyst brain, all NEXTTEAM outcomes with prices, trade history with audit trail, manual override controls (block player, max price slider, confidence boost buttons).
5. **Team view toggle** (bottom panel): Grid of NFL teams with positional needs color-coded (green=filled, red=high need), recent moves list, linked players.

Use polling intervals:
- Bot status: every 10s
- Player data + signals: every 15s
- Teams: every 60s

Style with Tailwind, matching the existing dark theme from other dashboard pages.

This is a large component (~500-800 lines). Key sub-components to define inline:
- `PlayerCard` — the grid card
- `PlayerDetail` — expanded view
- `SignalFeedItem` — individual signal in the feed
- `TeamCard` — team grid card
- `OverrideControls` — the manual override panel

**Step 2: Verify locally**

Run: `cd edgelord && npm run dev -- -p 3001`
Navigate to `http://localhost:3001/nfl-fa`

**Step 3: Commit**

```bash
git add src/app/nfl-fa/page.tsx
git commit -m "feat: NFL FA dashboard with player cards, signal feed, and team view"
```

---

## Phase 8: Integration & Testing

### Task 14: End-to-end dry run

**Step 1:** Run the bot with `NFL_TRADING_DISABLED = true`

```bash
cd scripts && deno run --allow-net --allow-env nfl-fa-bot.ts
```

Verify:
- Markets load correctly (check player count in logs)
- Twitter user IDs resolve
- Twitter polling starts (check for tweet logs)
- Deep analysis runs (check Groq call)
- State saves to Supabase
- Heartbeat sends to Telegram
- Dashboard loads data at `localhost:3001/nfl-fa`

**Step 2:** Test signal classification by finding a recent NFL insider tweet manually and verifying the LLM classifies it correctly in the logs.

**Step 3:** Test the override API:

```bash
curl -X POST http://localhost:3001/api/nfl/override \
  -H "Content-Type: application/json" \
  -d '{"type": "kill_player", "action": "add", "player": "Test Player"}'
```

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration fixes from dry run"
```

---

### Task 15: Enable trading and deploy

**Step 1:** Set `NFL_TRADING_DISABLED = false` in the bot script.

**Step 2:** Deploy to Railway (or run locally with live monitoring).

**Step 3:** Monitor first few signals and trades via Telegram + dashboard. Verify:
- Fast-path regex fires on confirmed-deal language
- LLM classification matches expectations
- Orders placed at correct prices on correct markets
- Signal→trade audit chain visible in dashboard
- Overrides work from dashboard UI

**Step 4: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: enable NFL FA bot trading"
```

---

## Task Dependency Graph

```
Phase 1: Task 1 (DB migration)
    ↓
Phase 2: Task 2 → Task 3 → Task 4 (bot scaffold → auth → markets)
    ↓
Phase 3: Task 5 → Task 6 → Task 7 → Task 8 (twitter → fast-path → LLM → execution)
    ↓
Phase 4: Task 9 (analyst brain)
    ↓
Phase 5: Task 10 (main loop + state)
    ↓
Phase 6: Task 11 (API routes) — can run in parallel with Phase 4-5
    ↓
Phase 7: Task 12 → Task 13 (nav + dashboard page)
    ↓
Phase 8: Task 14 → Task 15 (dry run → deploy)
```

**Parallelizable:** Tasks 11-13 (dashboard) can be built in parallel with Tasks 9-10 (analyst brain + main loop) since they share only the Supabase schema.
