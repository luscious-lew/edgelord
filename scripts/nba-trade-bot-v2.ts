/**
 * NBA Trade Deadline Bot v2 - Advanced Trading
 *
 * Features:
 * 1. Tiered confidence system (confirmed/imminent/serious/exploring)
 * 2. Next Team markets (destination bets)
 * 3. Contrary signals (sell YES / buy NO)
 *
 * Run with: deno run --allow-net --allow-env scripts/nba-trade-bot-v2.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// =============================================================================
// CONFIGURATION
// =============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") ?? "";
const TWITTER_BEARER_TOKEN = Deno.env.get("TWITTER_BEARER_TOKEN") ?? "";
const KALSHI_API_KEY_ID = Deno.env.get("KALSHI_API_KEY_ID") ?? "";
const KALSHI_PRIVATE_KEY = Deno.env.get("KALSHI_PRIVATE_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

let BASE_CONTRACT_COUNT = Number(Deno.env.get("TRADE_CONTRACT_COUNT") ?? "100");
const POLL_INTERVAL_MS = Number(Deno.env.get("POLL_INTERVAL_MS") ?? "30000");

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// =============================================================================
// DYNAMIC SETTINGS FROM SUPABASE
// =============================================================================

interface BotSettings {
  base_contract_count: number;
  max_price_confirmed: number;
  max_price_imminent: number;
  max_price_serious: number;
  min_volume_for_alert: number;
  min_volume_for_auto_buy: number;
  price_spike_threshold: number;
  price_spike_max_entry: number;
  price_spike_require_twitter: boolean;
  price_spike_cooldown_minutes: number;
  price_spike_position_limit: number;
  features: {
    twitter_monitoring: boolean;
    price_spike_trading: boolean;
    orderbook_monitoring: boolean;
    profit_taking: boolean;
    telegram_notifications: boolean;
  };
}

// Default settings
let botSettings: BotSettings = {
  base_contract_count: 100,
  max_price_confirmed: 99,
  max_price_imminent: 92,
  max_price_serious: 80,
  min_volume_for_alert: 15000,
  min_volume_for_auto_buy: 25000,
  price_spike_threshold: 20,
  price_spike_max_entry: 85,
  price_spike_require_twitter: true,
  price_spike_cooldown_minutes: 2,
  price_spike_position_limit: 50,
  features: {
    twitter_monitoring: true,
    price_spike_trading: false,
    orderbook_monitoring: true,
    profit_taking: true,
    telegram_notifications: true,
  },
};

let settingsLastFetched = 0;
const SETTINGS_REFRESH_MS = 60000; // Refresh every minute

async function loadSettings(force: boolean = false): Promise<void> {
  const now = Date.now();
  if (!force && now - settingsLastFetched < SETTINGS_REFRESH_MS) {
    return; // Use cached settings
  }

  try {
    const { data, error } = await supabase
      .from("bot_settings")
      .select("*")
      .eq("id", "nba-trade-bot")
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("[SETTINGS] Error loading settings:", error);
      return;
    }

    if (data?.settings) {
      const oldSettings = { ...botSettings };
      botSettings = { ...botSettings, ...data.settings };
      BASE_CONTRACT_COUNT = botSettings.base_contract_count;
      settingsLastFetched = now;

      // Log what changed
      const changes: string[] = [];
      if (oldSettings.base_contract_count !== botSettings.base_contract_count) changes.push(`contracts: ${botSettings.base_contract_count}`);
      if (oldSettings.max_price_confirmed !== botSettings.max_price_confirmed) changes.push(`confirmed: ${botSettings.max_price_confirmed}¢`);
      if (oldSettings.max_price_imminent !== botSettings.max_price_imminent) changes.push(`imminent: ${botSettings.max_price_imminent}¢`);
      if (oldSettings.price_spike_max_entry !== botSettings.price_spike_max_entry) changes.push(`spike max: ${botSettings.price_spike_max_entry}¢`);
      if (oldSettings.features.price_spike_trading !== botSettings.features.price_spike_trading) changes.push(`spike trading: ${botSettings.features.price_spike_trading ? "ON" : "OFF"}`);

      if (force || changes.length > 0) {
        console.log("[SETTINGS] " + (force ? "Force reloaded" : "Updated") + " from Supabase" + (changes.length > 0 ? `: ${changes.join(", ")}` : ""));

        // Update bot_status to confirm settings were loaded
        await supabase.from("bot_status").upsert({
          id: "nba-trade-bot",
          settings_loaded_at: new Date().toISOString(),
          settings_version: data.updated_at,
        });

        // Send notification if settings changed via realtime
        if (force && changes.length > 0) {
          await sendTelegramNotification(
            `⚙️ <b>SETTINGS UPDATED</b>\n\n` +
            changes.map(c => `• ${c}`).join("\n")
          );
        }
      }
    }
  } catch (e) {
    console.error("[SETTINGS] Failed to load settings:", e);
  }
}

// Subscribe to realtime settings changes
function subscribeToSettingsChanges(): void {
  console.log("[SETTINGS] Subscribing to realtime settings changes...");

  supabase
    .channel("bot-settings-changes")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "bot_settings",
        filter: "id=eq.nba-trade-bot",
      },
      async (payload) => {
        console.log("[SETTINGS] Realtime update received!");
        await loadSettings(true); // Force reload
      }
    )
    .subscribe((status) => {
      console.log("[SETTINGS] Realtime subscription status:", status);
    });
}

// Get dynamic confidence tier settings
function getConfidenceTierMaxPrice(tier: string): number {
  switch (tier) {
    case "Confirmed": return botSettings.max_price_confirmed;
    case "Imminent": return botSettings.max_price_imminent;
    case "Serious": return botSettings.max_price_serious;
    default: return 50;
  }
}

// =============================================================================
// SOURCE RELIABILITY SCORING
// =============================================================================

type SourceReliability = {
  source_handle: string;
  correct_predictions: number;
  incorrect_predictions: number;
  total_resolved: number;
  accuracy_pct: number | null;
  reliability_multiplier: number;
};

const sourceReliabilityCache: Record<string, SourceReliability> = {};
let lastReliabilityRefresh = 0;
const RELIABILITY_CACHE_TTL_MS = 300000; // 5 minutes

async function getSourceReliability(handle: string): Promise<number> {
  const now = Date.now();

  // Refresh cache if stale
  if (now - lastReliabilityRefresh > RELIABILITY_CACHE_TTL_MS) {
    try {
      const { data } = await supabase.from("source_reliability").select("*");
      if (data) {
        for (const row of data) {
          sourceReliabilityCache[row.source_handle] = row;
        }
        lastReliabilityRefresh = now;
      }
    } catch (e) {
      console.error("[RELIABILITY] Error fetching source reliability:", e);
    }
  }

  // Get tier-based multiplier first (used as fallback and for validation)
  const tierMultiplier = getSourceTierMultiplier(handle);
  const tier = tierMultiplier >= 1.2 ? "Tier 1" : tierMultiplier >= 0.8 ? "Tier 2" : "Tier 3";

  // Check historical reliability from database
  const reliability = sourceReliabilityCache[handle];
  if (reliability && reliability.total_resolved >= 3) {
    // Validate the data makes sense: correct + incorrect should roughly equal total_resolved
    const actualResolved = (reliability.correct_predictions ?? 0) + (reliability.incorrect_predictions ?? 0);

    if (actualResolved === 0 || actualResolved < reliability.total_resolved * 0.5) {
      // Data is corrupted (predictions not being resolved properly) - use tier multiplier
      console.log(`[RELIABILITY] @${handle}: ${tier} source (data incomplete: ${actualResolved}/${reliability.total_resolved} resolved), using tier multiplier: ${tierMultiplier}x`);
      return tierMultiplier;
    }

    // Data looks valid - use historical accuracy
    console.log(`[RELIABILITY] @${handle}: ${reliability.accuracy_pct ?? "N/A"}% accuracy (${reliability.correct_predictions}/${actualResolved} correct), multiplier: ${reliability.reliability_multiplier}x`);
    return reliability.reliability_multiplier;
  }

  // Fall back to tier-based multiplier for new/unknown sources
  console.log(`[RELIABILITY] @${handle}: ${tier} source, tier multiplier: ${tierMultiplier}x`);
  return tierMultiplier;
}

// Track prediction for later accuracy scoring
async function trackPrediction(
  handle: string,
  playerName: string,
  marketTicker: string,
  tier: string,
  tweetId: string,
  destinationTeam?: string
): Promise<void> {
  try {
    await supabase.from("source_predictions").upsert({
      source_handle: handle,
      player_name: playerName,
      market_ticker: marketTicker,
      prediction_type: destinationTeam ? "destination" : "trade",
      predicted_team: destinationTeam,
      confidence_tier: tier,
      tweet_id: tweetId,
      outcome: "pending",
    }, { onConflict: "tweet_id,player_name" });
  } catch (e) {
    console.error("[RELIABILITY] Error tracking prediction:", e);
  }
}

// =============================================================================
// DYNAMIC POSITION SIZING
// =============================================================================

function calculateDynamicPositionSize(
  basePct: number,
  confidenceScore: number,
  currentPrice: number,
  sourceMultiplier: number
): number {
  // Factors:
  // 1. Base position % from tier (0.25 for serious, 0.5 for imminent, 1.0 for confirmed)
  // 2. Confidence score (0-100) - higher = bigger position
  // 3. Current price/odds - lower price = better odds = bigger position
  // 4. Source reliability multiplier (0.5-1.5)

  // Odds factor: if price is 50c, potential profit is 50c (1:1)
  // if price is 20c, potential profit is 80c (4:1) - more attractive
  const oddsMultiplier = currentPrice > 0 ? Math.min(2.0, (100 - currentPrice) / 50) : 1.0;

  // Confidence factor: scale from 0.5x to 1.5x based on 0-100 score
  const confidenceMultiplier = 0.5 + (confidenceScore / 100);

  // Final calculation
  const finalPct = basePct * oddsMultiplier * confidenceMultiplier * sourceMultiplier;

  console.log(`[SIZING] Base: ${(basePct * 100).toFixed(0)}%, Odds: ${oddsMultiplier.toFixed(2)}x, Conf: ${confidenceMultiplier.toFixed(2)}x, Source: ${sourceMultiplier.toFixed(2)}x = ${(finalPct * 100).toFixed(0)}%`);

  // Cap at 2x base position
  return Math.min(finalPct, basePct * 2);
}

// =============================================================================
// KALSHI BALANCE API
// =============================================================================

async function getKalshiBalance(): Promise<{ cash: number; positionValue: number; totalPortfolio: number } | null> {
  try {
    const path = "/trade-api/v2/portfolio/balance";
    const headers = await getKalshiHeaders("GET", path);
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });

    if (!response.ok) {
      console.error("[BALANCE] Failed to fetch balance:", response.status);
      return null;
    }

    const data = await response.json();

    // Kalshi API naming is confusing:
    // - "balance" = cash available
    // - "portfolio_value" = value of positions (NOT total portfolio!)
    const cash = (data.balance ?? 0) / 100;
    const positionValue = (data.portfolio_value ?? 0) / 100;
    const totalPortfolio = cash + positionValue;

    return { cash, positionValue, totalPortfolio };
  } catch (e) {
    console.error("[BALANCE] Error fetching balance:", e);
    return null;
  }
}

// =============================================================================
// DAILY P&L SUMMARY (#15)
// =============================================================================

async function sendDailySummary(): Promise<void> {
  try {
    // Get actual Kalshi balance
    const kalshiBalance = await getKalshiBalance();

    // Get all positions
    const positions = await getAllPositions();

    // Get today's trades
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: todaysTrades } = await supabase
      .from("trades")
      .select("*")
      .gte("executed_at", today.toISOString());

    // Calculate position values
    let totalPositionValue = 0;
    let totalCost = 0;
    const positionDetails: string[] = [];

    for (const pos of positions) {
      const market = tradeMarkets.find(m => m.ticker === pos.ticker);
      // IMPORTANT: Use correct price based on position side (YES vs NO)
      const yesPrice = market?.yes_price ? Math.round(market.yes_price * 100) : 50;
      const currentPrice = pos.side === "yes" ? yesPrice : (100 - yesPrice);
      const value = (currentPrice * pos.contracts) / 100;
      totalPositionValue += value;

      // Get average cost from trades
      const { data: posTrades } = await supabase
        .from("trades")
        .select("price_cents, contract_count")
        .eq("market_ticker", pos.ticker)
        .eq("action", "buy");

      let avgCost = 50;
      if (posTrades && posTrades.length > 0) {
        const totalContracts = posTrades.reduce((sum, t) => sum + t.contract_count, 0);
        const totalSpent = posTrades.reduce((sum, t) => sum + (t.price_cents * t.contract_count), 0);
        avgCost = totalContracts > 0 ? totalSpent / totalContracts : 50;
      }
      totalCost += (avgCost * pos.contracts) / 100;

      const pnl = value - (avgCost * pos.contracts) / 100;
      const pnlPct = avgCost > 0 ? ((currentPrice - avgCost) / avgCost * 100).toFixed(0) : "0";
      positionDetails.push(`• ${market?.player_name ?? pos.ticker}: ${pos.contracts} @ ${currentPrice}¢ (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, ${pnlPct}%)`);
    }

    const unrealizedPnL = totalPositionValue - totalCost;
    const tradesCount = todaysTrades?.length ?? 0;

    // Use Kalshi's reported values directly (most accurate)
    const portfolioDisplay = kalshiBalance
      ? `• Portfolio: <b>$${kalshiBalance.totalPortfolio.toFixed(2)}</b>\n• Positions: $${kalshiBalance.positionValue.toFixed(2)}\n• Cash: $${kalshiBalance.cash.toFixed(2)}`
      : `• Positions: ${positions.length}\n• Cost Basis: $${totalCost.toFixed(2)}`;

    const summary = `📊 <b>DAILY SUMMARY</b>\n\n` +
      `<b>Positions (${positions.length}):</b>\n${positionDetails.slice(0, 10).join("\n") || "None"}\n\n` +
      `<b>Portfolio:</b>\n` +
      `${portfolioDisplay}\n\n` +
      `<b>Today's Activity:</b>\n` +
      `• Trades: ${tradesCount}`;

    await sendTelegramNotification(summary);
  } catch (e) {
    console.error("[SUMMARY] Error generating daily summary:", e);
  }
}

// =============================================================================
// WIN RATE TRACKING (#14)
// =============================================================================

async function sendWinRateReport(): Promise<void> {
  try {
    // Get source reliability stats
    const { data: sourceStats } = await supabase
      .from("source_reliability")
      .select("*")
      .order("total_resolved", { ascending: false });

    if (!sourceStats || sourceStats.length === 0) {
      await sendTelegramNotification("📈 <b>WIN RATE REPORT</b>\n\nNo resolved predictions yet.");
      return;
    }

    const sourceLines = sourceStats.map(s =>
      `• @${s.source_handle}: ${s.accuracy_pct ?? "N/A"}% (${s.correct_predictions}/${s.total_resolved})`
    ).join("\n");

    // Get tier performance
    const { data: tierStats } = await supabase
      .from("source_predictions")
      .select("confidence_tier, outcome")
      .not("outcome", "is", null);

    const tierMap: Record<string, { correct: number; total: number }> = {};
    for (const pred of tierStats ?? []) {
      if (!tierMap[pred.confidence_tier]) {
        tierMap[pred.confidence_tier] = { correct: 0, total: 0 };
      }
      tierMap[pred.confidence_tier].total++;
      if (pred.outcome === "correct") {
        tierMap[pred.confidence_tier].correct++;
      }
    }

    const tierLines = Object.entries(tierMap).map(([tier, stats]) =>
      `• ${tier}: ${stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(0) : "N/A"}% (${stats.correct}/${stats.total})`
    ).join("\n");

    const report = `📈 <b>WIN RATE REPORT</b>\n\n` +
      `<b>By Source:</b>\n${sourceLines || "No data"}\n\n` +
      `<b>By Tier:</b>\n${tierLines || "No data"}`;

    await sendTelegramNotification(report);
  } catch (e) {
    console.error("[WIN_RATE] Error generating win rate report:", e);
  }
}

// =============================================================================
// PRICE HISTORY & MARKET EVENTS
// =============================================================================

async function initPriceHistoryTables(): Promise<void> {
  // Create tables if they don't exist (using raw SQL via rpc or just try insert)
  // Tables should be created via migration, but this is a fallback
  console.log("[INIT] Price history tables ready");
}

async function recordPriceHistory(): Promise<void> {
  try {
    const rows = tradeMarkets.map(m => ({
      ticker: m.ticker,
      player_name: m.player_name,
      price_cents: m.yes_price ? Math.round(m.yes_price * 100) : 0,
      volume: m.volume,
      open_interest: m.open_interest,
      recorded_at: new Date().toISOString(),
    }));

    if (rows.length > 0) {
      await supabase.from("price_history").insert(rows);
    }
  } catch (e) {
    // Silently fail if table doesn't exist yet
    if (!String(e).includes("does not exist")) {
      console.error("[PRICE_HISTORY] Error recording:", e);
    }
  }
}

async function recordMarketEvent(
  ticker: string,
  playerName: string,
  eventType: string,
  description: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await supabase.from("market_events").insert({
      ticker,
      player_name: playerName,
      event_type: eventType,
      description,
      metadata,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    // Silently fail if table doesn't exist yet
    if (!String(e).includes("does not exist")) {
      console.error("[MARKET_EVENT] Error recording:", e);
    }
  }
}

// =============================================================================
// TELEGRAM NOTIFICATIONS
// =============================================================================

async function sendTelegramNotification(message: string, retries = 3): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return; // Telegram not configured
  }

  // Check feature toggle (but always allow startup messages)
  if (!botSettings.features.telegram_notifications && !message.includes("BOT STARTED")) {
    return;
  }

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

      if (response.ok) {
        return; // Success
      }

      // Non-retryable error (bad request, unauthorized, etc.)
      if (response.status >= 400 && response.status < 500) {
        console.error(`[TELEGRAM] Error ${response.status}: ${await response.text()}`);
        return;
      }

      // Server error - retry
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
        console.log(`[TELEGRAM] Retry ${attempt}/${retries} after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (e) {
      // Connection error - retry with backoff
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 500;
        console.log(`[TELEGRAM] Connection error, retry ${attempt}/${retries} after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[TELEGRAM] Failed after ${retries} attempts:`, String(e).substring(0, 100));
      }
    }
  }
}

// =============================================================================
// FLIGHT TRACKING (#4)
// =============================================================================

// NBA team plane tail numbers (partial list - these change frequently)
const TEAM_PLANES: Record<string, string[]> = {
  "LAL": ["N954LA"], // Lakers
  "BOS": ["N654CE"], // Celtics
  "MIA": ["N720MM"], // Heat
  "GSW": ["N547GS"], // Warriors
  "PHX": ["N478US"], // Suns
  "DAL": ["N67MV"], // Mavericks
  "NYK": ["N25NY"], // Knicks
  // Add more as discovered
};

// City to team mapping for destination detection
const CITY_TO_TEAM: Record<string, string> = {
  "los angeles": "LAL", "lax": "LAL",
  "boston": "BOS", "bos": "BOS",
  "miami": "MIA", "mia": "MIA",
  "san francisco": "GSW", "sfo": "GSW", "oakland": "GSW",
  "phoenix": "PHX", "phx": "PHX",
  "dallas": "DAL", "dfw": "DAL",
  "new york": "NYK", "jfk": "NYK", "lga": "NYK",
  "chicago": "CHI", "ord": "CHI", "mdw": "CHI",
  "houston": "HOU", "iah": "HOU",
  "philadelphia": "PHI", "phl": "PHI",
  "cleveland": "CLE", "cle": "CLE",
  "sacramento": "SAC", "smf": "SAC",
  "denver": "DEN", "den": "DEN",
  "minneapolis": "MIN", "msp": "MIN",
  "memphis": "MEM", "mem": "MEM",
  "new orleans": "NOP", "msy": "NOP",
  "san antonio": "SAS", "sat": "SAS",
  "orlando": "ORL", "mco": "ORL",
  "atlanta": "ATL", "atl": "ATL",
  "charlotte": "CHA", "clt": "CHA",
  "detroit": "DET", "dtw": "DET",
  "toronto": "TOR", "yyz": "TOR",
  "milwaukee": "MIL", "mke": "MIL",
  "portland": "POR", "pdx": "POR",
  "oklahoma city": "OKC", "okc": "OKC",
  "salt lake city": "UTA", "slc": "UTA",
  "indianapolis": "IND", "ind": "IND",
  "washington": "WAS", "dca": "WAS", "iad": "WAS",
  "brooklyn": "BKN",
};

async function checkFlightActivity(): Promise<void> {
  // Note: This requires a flight tracking API key (FlightAware, ADS-B Exchange, etc.)
  // For now, this is a placeholder that can be enabled when API access is available
  const FLIGHTAWARE_API_KEY = Deno.env.get("FLIGHTAWARE_API_KEY") ?? "";

  if (!FLIGHTAWARE_API_KEY) {
    return; // Flight tracking not configured
  }

  console.log("[FLIGHTS] Checking team plane activity...");

  for (const [team, tailNumbers] of Object.entries(TEAM_PLANES)) {
    for (const tail of tailNumbers) {
      try {
        // FlightAware API call (requires paid subscription)
        const response = await fetch(
          `https://aeroapi.flightaware.com/aeroapi/flights/${tail}`,
          {
            headers: { "x-apikey": FLIGHTAWARE_API_KEY },
          }
        );

        if (!response.ok) continue;

        const data = await response.json();
        const flights = data.flights ?? [];

        for (const flight of flights) {
          const dest = flight.destination?.city?.toLowerCase() ?? "";
          const destTeam = CITY_TO_TEAM[dest];

          // If team plane is flying to another team's city, that's interesting
          if (destTeam && destTeam !== team) {
            console.log(`[FLIGHTS] 🛫 ${team} plane flying to ${dest} (${destTeam})`);

            await sendTelegramNotification(
              `✈️ <b>FLIGHT ALERT</b>\n\n` +
              `${team} team plane (${tail})\n` +
              `Destination: ${dest.toUpperCase()} (${destTeam})\n\n` +
              `⚠️ Unusual flight - possible trade meeting?`
            );

            // Store signal
            await supabase.from("signals").insert({
              market_id: `flight-${team}-${destTeam}`,
              signal_type: "flight_activity",
              meta: {
                source_team: team,
                destination_team: destTeam,
                tail_number: tail,
                destination_city: dest,
              },
            });
          }
        }
      } catch (e) {
        // Silently fail - flight tracking is supplementary
      }
    }
  }
}

// Trusted NBA insiders (handle -> Twitter user ID)
// To find a user ID: https://api.twitter.com/2/users/by/username/{handle}
const TRUSTED_SOURCES: Record<string, string> = {
  // ═══════════════════════════════════════════════════════════════════
  // TIER 1 - League-wide news breakers (polled every 5 seconds)
  // ═══════════════════════════════════════════════════════════════════
  "ShamsCharania": "178580925",      // The Athletic - FASTEST on trades
  "TheSteinLine": "48488561",        // Marc Stein - Independent
  // Note: wojespn removed - Woj retired from reporting
  "WindhorstESPN": "193095044",      // ESPN senior
  "ZachLowe_NBA": "23378774",        // ESPN - Analysis + breaking
  "ChrisBHaynes": "57710919",        // TNT/Bleacher Report
  "JakeLFischer": "279252839",       // Yahoo Sports
  "ramonashelburne": "17507250",     // ESPN senior
  "BobbyMarks42": "299267941",       // ESPN cap expert

  // ═══════════════════════════════════════════════════════════════════
  // TIER 2 - High-signal aggregators (good for amplifying, verify first)
  // ═══════════════════════════════════════════════════════════════════
  "HoopsRumors": "338159612",        // Aggregator - not original sourcing
  "RealGM": "46677640",              // Aggregator
  "BR_NBA": "36724576",              // Bleacher Report NBA
  "TheNBACentral": "3316207295",     // Aggregator - needs verification
  "TheAthletic": "1985451134",       // The Athletic main account

  // ═══════════════════════════════════════════════════════════════════
  // TIER 3 - Beat reporters (team-specific, reliable for their teams)
  // ═══════════════════════════════════════════════════════════════════
  // Lakers
  "mcten": "22494516",               // Dave McMenamin - ESPN Lakers
  "jovanbuha": "42820745",           // Jovan Buha - The Athletic Lakers
  // Clippers
  "LawMurrayTheNU": "66042578",      // Law Murray - The Athletic Clippers
  // Warriors
  "anthonyVslater": "77577780",      // Anthony Slater - The Athletic Warriors
  // Celtics
  "ByJayKing": "38032945",           // Jay King - The Athletic Celtics
  "JaredWeissNBA": "33816689",       // Jared Weiss - The Athletic Celtics
  // Sixers
  "DerekBodnerNBA": "61875868",      // Derek Bodner - Sixers
  // Heat
  "IraHeatBeat": "39346451",         // Ira Winderman - Heat
  // Bucks
  "eric_nehm": "139936969",          // Eric Nehm - The Athletic Bucks
  // Suns
  "DuaneRankin": "126500061",        // Duane Rankin - Suns
  // Mavs
  "tim_cato": "560447335",           // Tim Cato - The Athletic Mavs
  // Knicks
  "IanBegley": "164076105",          // Ian Begley - SNY Knicks
  "FredKatz": "73834352",            // Fred Katz - The Athletic Knicks
  // Nets
  "Alex__Schiffer": "262952138",     // Alex Schiffer - The Athletic Nets
  // Raptors
  "BlakeMurphyODC": "14872954",      // Blake Murphy - Raptors
  // Bulls
  "KCJHoop": "17106279",             // K.C. Johnson - Bulls
  // Pelicans
  "WillGuillory": "201105510",       // Will Guillory - The Athletic Pelicans
  // Wolves
  "JonKrawczynski": "38251431",      // Jon Krawczynski - The Athletic Wolves
  // Thunder
  "joe_mussatto": "178418316",       // Joe Mussatto - Thunder
  // Kings
  "James_HamNBA": "24591063",        // James Ham - Kings
};

// Source tier for reliability weighting (1.0 = full trust, lower = discount)
const SOURCE_TIERS: Record<string, number> = {
  // Tier 1 - Act immediately on confirmed news (1.5x weight)
  "ShamsCharania": 1.5, "TheSteinLine": 1.4,
  "WindhorstESPN": 1.2, "ZachLowe_NBA": 1.2, "ChrisBHaynes": 1.2,
  "JakeLFischer": 1.2, "ramonashelburne": 1.2, "BobbyMarks42": 1.1,
  // Tier 2 - Verify before acting (0.7x weight)
  "HoopsRumors": 0.7, "RealGM": 0.7, "BR_NBA": 0.8,
  "TheNBACentral": 0.5, "TheAthletic": 0.9,
  // Tier 3 - Beat reporters (1.0x for their team, useful context)
  // Default to 1.0 for beat reporters
};

// Get source reliability multiplier
function getSourceTierMultiplier(handle: string): number {
  return SOURCE_TIERS[handle] ?? 1.0;
}

// NOTE: To verify/add Twitter IDs, use:
// curl -H "Authorization: Bearer $TOKEN" "https://api.twitter.com/2/users/by/username/{handle}"

// Team name mappings (various formats -> Kalshi code)
const TEAM_CODES: Record<string, string> = {
  "hawks": "ATL", "atlanta": "ATL",
  "celtics": "BOS", "boston": "BOS",
  "nets": "BKN", "brooklyn": "BKN",
  "hornets": "CHA", "charlotte": "CHA",
  "bulls": "CHI", "chicago": "CHI",
  "cavaliers": "CLE", "cleveland": "CLE", "cavs": "CLE",
  "mavericks": "DAL", "dallas": "DAL", "mavs": "DAL",
  "nuggets": "DEN", "denver": "DEN",
  "pistons": "DET", "detroit": "DET",
  "warriors": "GSW", "golden state": "GSW",
  "rockets": "HOU", "houston": "HOU",
  "pacers": "IND", "indiana": "IND",
  "clippers": "LAC", "la clippers": "LAC", "los angeles c": "LAC",
  "lakers": "LAL", "la lakers": "LAL", "los angeles l": "LAL",
  "grizzlies": "MEM", "memphis": "MEM",
  "heat": "MIA", "miami": "MIA",
  "bucks": "MIL", "milwaukee": "MIL",
  "timberwolves": "MIN", "minnesota": "MIN", "wolves": "MIN",
  "pelicans": "NOP", "new orleans": "NOP",
  "knicks": "NYK", "new york": "NYK",
  "thunder": "OKC", "oklahoma city": "OKC",
  "magic": "ORL", "orlando": "ORL",
  "76ers": "PHI", "philadelphia": "PHI", "sixers": "PHI",
  "suns": "PHX", "phoenix": "PHX",
  "trail blazers": "POR", "portland": "POR", "blazers": "POR",
  "kings": "SAC", "sacramento": "SAC",
  "spurs": "SAS", "san antonio": "SAS",
  "raptors": "TOR", "toronto": "TOR",
  "jazz": "UTA", "utah": "UTA",
  "wizards": "WAS", "washington": "WAS",
};

// =============================================================================
// CONFIDENCE TIERS
// =============================================================================

type ConfidenceTier = {
  level: number;
  name: string;
  positionPct: number;  // % of base position
  maxPrice: number;     // Max cents to pay
  action: "buy_yes" | "buy_no" | "sell_yes" | "hold";
};

// Dynamic confidence tiers - use getConfidenceTier() to get current values
function getConfidenceTiers(): Record<string, ConfidenceTier> {
  return {
    CONFIRMED: { level: 1, name: "Confirmed", positionPct: 1.0, maxPrice: botSettings.max_price_confirmed, action: "buy_yes" },
    IMMINENT: { level: 2, name: "Imminent", positionPct: 0.5, maxPrice: botSettings.max_price_imminent, action: "buy_yes" },
    SERIOUS: { level: 3, name: "Serious", positionPct: 0.25, maxPrice: botSettings.max_price_serious, action: "buy_yes" },
    EXPLORING: { level: 4, name: "Exploring", positionPct: 0, maxPrice: 0, action: "hold" },
    NEGATIVE: { level: 5, name: "Negative", positionPct: 0.5, maxPrice: 50, action: "buy_no" },
  };
}

// For backward compatibility - will be replaced by dynamic lookup
const CONFIDENCE_TIERS: Record<string, ConfidenceTier> = {
  CONFIRMED: { level: 1, name: "Confirmed", positionPct: 1.0, maxPrice: 99, action: "buy_yes" },
  IMMINENT: { level: 2, name: "Imminent", positionPct: 0.5, maxPrice: 92, action: "buy_yes" },
  SERIOUS: { level: 3, name: "Serious", positionPct: 0.25, maxPrice: 80, action: "buy_yes" },
  EXPLORING: { level: 4, name: "Exploring", positionPct: 0, maxPrice: 0, action: "hold" },
  NEGATIVE: { level: 5, name: "Negative", positionPct: 0.5, maxPrice: 50, action: "buy_no" },
};

// Keywords for each tier
const TIER_KEYWORDS = {
  CONFIRMED: [
    "traded to", "has been traded", "is being traded", "deal done", "deal is done",
    "trade complete", "sending", "just in:", "breaking:",
    "trade finalized", "officially traded", "deal agreed",
  ],
  IMMINENT: [
    "finalizing", "close to done", "expected to", "on verge of", "imminent",
    "agreement in place", "will be traded", "set to acquire", "poised to",
    "working to finalize", "nearing completion",
  ],
  SERIOUS: [
    "ramped up", "serious discussions", "pushing hard", "engaged in talks",
    "in deep negotiations", "progressing", "gaining momentum", "intensifying",
    "advanced talks", "significant progress",
  ],
  EXPLORING: [
    "interested in", "exploring", "could", "might", "discussing",
    "monitoring", "keeping an eye on", "on their radar",
  ],
  NEGATIVE: [
    "no longer", "not trading", "staying", "removed from", "off the table",
    "talks stalled", "unlikely", "not happening", "will not be traded",
    "committed to staying", "ruled out", "deal fell through",
    "pivoted to", "pivoted away", "instead of", "rather than", "passed on",
    "went with", "chose", "opted for",
  ],
};

// Context patterns that NEGATE a player's trade likelihood even if keywords match
// These indicate the player was mentioned but NOT as the trade target
const NEGATIVE_CONTEXT_PATTERNS = [
  /pivoted.*?(?:to|away from)\s+(.+?)\s+(?:and|to)\s+acquired/i,  // "pivoted to X and acquired Y" - Y is traded, not X
  /hoped would be.*?trade suitor/i,  // "hoped X would be suitor" = X didn't trade for them
  /instead.*?acquired/i,  // "instead acquired" = different player
  /rather than/i,
  /passed on.*?for/i,
  /chose.*?over/i,
  /previously.*?but/i,  // "previously X but now Y" = situation changed
];

function classifyConfidence(text: string): ConfidenceTier {
  const lowerText = text.toLowerCase();

  // Check negative first (takes priority)
  if (TIER_KEYWORDS.NEGATIVE.some(kw => lowerText.includes(kw))) {
    return CONFIDENCE_TIERS.NEGATIVE;
  }

  // Check from highest to lowest confidence
  if (TIER_KEYWORDS.CONFIRMED.some(kw => lowerText.includes(kw))) {
    return CONFIDENCE_TIERS.CONFIRMED;
  }
  if (TIER_KEYWORDS.IMMINENT.some(kw => lowerText.includes(kw))) {
    return CONFIDENCE_TIERS.IMMINENT;
  }
  if (TIER_KEYWORDS.SERIOUS.some(kw => lowerText.includes(kw))) {
    return CONFIDENCE_TIERS.SERIOUS;
  }
  if (TIER_KEYWORDS.EXPLORING.some(kw => lowerText.includes(kw))) {
    return CONFIDENCE_TIERS.EXPLORING;
  }

  return CONFIDENCE_TIERS.EXPLORING; // Default to no action
}

// Check if a player is mentioned in a NEGATIVE context (passed over, not the actual trade target)
function isNegativeContextForPlayer(text: string, playerName: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerPlayer = playerName.toLowerCase();

  // Pattern: "[Team] hoped would be a [Player] trade suitor" = Team didn't get Player
  if (lowerText.includes("hoped") && lowerText.includes("suitor") && lowerText.includes(lowerPlayer)) {
    return true;
  }

  // Pattern: "pivoted to [Other Player]" when our player was mentioned as alternative
  if (lowerText.includes("pivoted") && lowerText.includes(lowerPlayer)) {
    // Check if player comes BEFORE "pivoted" (they were passed over)
    const playerIdx = lowerText.indexOf(lowerPlayer);
    const pivotIdx = lowerText.indexOf("pivoted");
    if (playerIdx < pivotIdx) {
      return true; // Player mentioned before pivot = they were the one passed over
    }
  }

  // Pattern: "instead of [Player]" or "rather than [Player]"
  const insteadPatterns = [
    new RegExp(`instead of.*${lowerPlayer}`, "i"),
    new RegExp(`rather than.*${lowerPlayer}`, "i"),
    new RegExp(`passed on.*${lowerPlayer}`, "i"),
    new RegExp(`chose.*over.*${lowerPlayer}`, "i"),
  ];
  if (insteadPatterns.some(p => p.test(lowerText))) {
    return true;
  }

  // Pattern: Player mentioned as who they "previously hoped" to trade for
  if (lowerText.includes("previously") && lowerText.includes(lowerPlayer)) {
    return true;
  }

  return false;
}

// Determine who is ACTUALLY being traded vs just mentioned
function extractActualTradeTarget(text: string): { player: string; isPositive: boolean } | null {
  const lowerText = text.toLowerCase();

  // Pattern: "acquired [Player]" - this player IS being traded
  const acquiredMatch = text.match(/acquired\s+(?:the\s+)?(?:\w+\s+)?([A-Z][a-z]+\s+[A-Z][a-zčćžšđ]+)/);
  if (acquiredMatch) {
    return { player: acquiredMatch[1], isPositive: true };
  }

  // Pattern: "[Player] is being traded to" - this player IS being traded
  const tradedToMatch = text.match(/([A-Z][a-z]+\s+[A-Z][a-zčćžšđ]+)\s+(?:is being|has been|will be)\s+traded/);
  if (tradedToMatch) {
    return { player: tradedToMatch[1], isPositive: true };
  }

  return null;
}

// =============================================================================
// MARKET TYPES
// =============================================================================

type TradeMarket = {
  id: string;
  ticker: string;
  player_name: string;
  yes_price: number | null;
  volume: number;
  open_interest: number;
  type: "trade";
};

type NextTeamMarket = {
  id: string;
  ticker: string;
  player_name: string;
  team_code: string;
  team_name: string;
  yes_price: number | null;
  type: "next_team";
};

type Market = TradeMarket | NextTeamMarket;

let tradeMarkets: TradeMarket[] = [];
let nextTeamMarkets: NextTeamMarket[] = [];
let lastMarketRefresh = 0;
const MARKET_CACHE_TTL_MS = 60000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =============================================================================
// GROQ LLM ANALYSIS
// =============================================================================

type LLMPlayerAnalysis = {
  name: string;
  is_being_traded: boolean;
  confidence: "confirmed" | "imminent" | "serious" | "exploring" | "negative";
  confidence_score: number;  // 0-100 scale
  sentiment_score: number;   // -100 (very negative) to +100 (very positive)
  reasoning: string;
  destination_team?: string;
};

type LLMTradeAnalysis = {
  players: LLMPlayerAnalysis[];
  analysis_id?: number;  // Supabase ID after storing
};

async function analyzeWithLLM(tweetText: string, author: string, tweetId: string): Promise<LLMTradeAnalysis | null> {
  if (!GROQ_API_KEY) {
    return null; // Fall back to keyword matching
  }

  const startTime = Date.now();

  const prompt = `You are an NBA TRADE DEADLINE analyst. Your ONLY job is to identify players being TRADED between NBA teams.

Tweet from @${author}: "${tweetText}"

CRITICAL: We are ONLY looking for ACTUAL TRADES - a player permanently moving from one NBA team to another.

THIS IS NOT A TRADE (return empty players array):
- Player is INJURED or OUT for a game ("without Player X", "Player X is out")
- ALL-STAR GAME roster moves ("moves to Team World", "added to All-Star team")
- Game previews or predictions
- Contract extensions or signings
- Player stats or performance
- General NBA news not about trades
- Draft picks or rookie assignments

THIS IS A TRADE (analyze the player):
- "Player X traded to Team Y"
- "Team Y acquires Player X from Team Z"
- "Deal done: Player X going to Team Y"
- "Sources: Player X has been traded"
- "Trade talks intensifying for Player X"
- "Team Y in serious discussions for Player X"

CRITICAL FOR SWAP TRADES:
When two players are exchanged, each player goes to the OTHER team:
- "Team A trading Player X to Team B for Player Y"
  → Player X destination = Team B
  → Player Y destination = Team A
- "Clippers trading Harden to Cavaliers for Garland"
  → Harden destination = Cavaliers
  → Garland destination = Clippers (NOT Cavaliers!)

The destination_team is where the player is GOING TO, not where they came from.

For each player ACTUALLY BEING TRADED between NBA teams:
{
  "players": [
    {
      "name": "Full Player Name",
      "is_being_traded": true,
      "confidence": "confirmed" | "imminent" | "serious" | "exploring" | "negative",
      "confidence_score": 0-100,
      "sentiment_score": -100 to +100,
      "reasoning": "why this is a trade signal",
      "destination_team": "Team they are GOING TO (not where they came from)"
    }
  ]
}

Confidence levels:
- confirmed: Trade is done/announced (95+ score)
- imminent: Deal expected to close soon (70-94 score)
- serious: Active negotiations (50-69 score)
- exploring: Early talks/interest (20-49 score)
- negative: Trade unlikely/fell through (use negative sentiment_score)

If the tweet is NOT about an actual NBA trade, return: {"players": []}

Return ONLY valid JSON, no markdown.`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 600,
      }),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      console.error(`[GROQ] API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[GROQ] No JSON in response:", content);
      return null;
    }

    const analysis = JSON.parse(jsonMatch[0]) as LLMTradeAnalysis;
    console.log(`[GROQ] Analyzed in ${latencyMs}ms: ${analysis.players.length} players found`);

    // Store analysis in Supabase for audit trail
    try {
      const { data: stored } = await supabase.from("llm_analyses").insert({
        tweet_id: tweetId,
        author_handle: author,
        tweet_text: tweetText,
        model: "llama-3.3-70b-versatile",
        latency_ms: latencyMs,
        raw_response: data,
        players_analyzed: analysis.players,
      }).select("id").single();

      if (stored) {
        analysis.analysis_id = stored.id;
        console.log(`[GROQ] Stored analysis #${stored.id}`);
      }
    } catch (e) {
      console.error("[GROQ] Error storing analysis:", e);
    }

    return analysis;
  } catch (e) {
    console.error("[GROQ] Error:", e);
    return null;
  }
}

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
// MARKET CACHE
// =============================================================================

function extractPlayerName(title: string): string | null {
  const match = title.match(/will\s+(.+?)\s+be\s+traded/i);
  if (match) return match[1].trim();
  const match2 = title.match(/^(.+?)\s+traded\s+before/i);
  if (match2) return match2[1].trim();
  const match3 = title.match(/what will be\s+(.+?)'s\s+next\s+team/i);
  if (match3) return match3[1].trim();
  return null;
}

async function refreshMarketCache(): Promise<void> {
  const now = Date.now();
  if (now - lastMarketRefresh < MARKET_CACHE_TTL_MS && tradeMarkets.length > 0) {
    return;
  }

  console.log("[CACHE] Refreshing markets...");

  // Fetch trade markets from Kalshi
  try {
    const tradeResp = await fetch(`${KALSHI_BASE.replace('/trade-api/v2', '')}/trade-api/v2/markets?series_ticker=KXNBATRADE&status=open`);
    const tradeData = await tradeResp.json();

    tradeMarkets = (tradeData.markets ?? []).map((m: any) => ({
      id: m.ticker,
      ticker: m.ticker,
      player_name: extractPlayerName(m.title) ?? m.yes_sub_title ?? "",
      yes_price: m.last_price / 100,
      volume: m.volume ?? 0,
      open_interest: m.open_interest ?? 0,
      type: "trade" as const,
    })).filter((m: TradeMarket) => m.player_name);

    console.log(`[CACHE] Loaded ${tradeMarkets.length} trade markets`);
  } catch (e) {
    console.error("[CACHE] Error fetching trade markets:", e);
  }

  // Fetch next team markets
  try {
    const nextTeamResp = await fetch(`${KALSHI_BASE.replace('/trade-api/v2', '')}/trade-api/v2/markets?series_ticker=KXNEXTTEAMNBA&status=open&limit=200`);
    const nextTeamData = await nextTeamResp.json();

    // Also fetch Giannis-specific markets
    const giannisResp = await fetch(`${KALSHI_BASE.replace('/trade-api/v2', '')}/trade-api/v2/markets?series_ticker=KXNEXTTEAMGIANNIS&status=open`);
    const giannisData = await giannisResp.json();

    const allNextTeam = [...(nextTeamData.markets ?? []), ...(giannisData.markets ?? [])];

    nextTeamMarkets = allNextTeam.map((m: any) => ({
      id: m.ticker,
      ticker: m.ticker,
      player_name: extractPlayerName(m.title) ?? "",
      team_code: m.ticker.split("-").pop() ?? "",
      team_name: m.custom_strike?.Team ?? m.yes_sub_title ?? "",
      yes_price: m.last_price / 100,
      type: "next_team" as const,
    })).filter((m: NextTeamMarket) => m.player_name && m.team_code);

    console.log(`[CACHE] Loaded ${nextTeamMarkets.length} next team markets`);
  } catch (e) {
    console.error("[CACHE] Error fetching next team markets:", e);
  }

  // Also upsert to Supabase for the UI
  if (tradeMarkets.length > 0) {
    const rows = tradeMarkets.map(m => ({
      venue: "kalshi",
      venue_market_ticker: m.ticker,
      venue_series_ticker: "KXNBATRADE",
      title: `Will ${m.player_name} be traded?`,
      category: "sports",
      status: "open",
      yes_price_last: m.yes_price,
    }));
    await supabase.from("markets").upsert(rows, { onConflict: "venue,venue_market_ticker" });
  }

  lastMarketRefresh = now;
}

// =============================================================================
// PRICE MOVEMENT DETECTION
// =============================================================================

type PriceSnapshot = {
  price: number;
  timestamp: number;
};

const priceHistory: Record<string, PriceSnapshot[]> = {};
const PRICE_ALERT_THRESHOLD = 0.10; // 10% movement triggers alert
const PRICE_HISTORY_WINDOW_MS = 5 * 60 * 1000; // 5 minute window

// Volume thresholds now come from botSettings (loaded from Supabase)
// botSettings.min_volume_for_alert = 5000 (default)
// botSettings.min_volume_for_auto_buy = 10000 (default)

async function checkPriceMovements(): Promise<void> {
  const now = Date.now();

  for (const market of tradeMarkets) {
    if (!market.yes_price) continue;

    const ticker = market.ticker;
    const currentPrice = market.yes_price;
    const volume = market.volume;
    const openInterest = market.open_interest;

    // Initialize history for this market
    if (!priceHistory[ticker]) {
      priceHistory[ticker] = [];
    }

    // Add current price to history
    priceHistory[ticker].push({ price: currentPrice, timestamp: now });

    // Clean old entries
    priceHistory[ticker] = priceHistory[ticker].filter(
      (p) => now - p.timestamp < PRICE_HISTORY_WINDOW_MS
    );

    // Check for significant movement
    if (priceHistory[ticker].length >= 2) {
      const oldest = priceHistory[ticker][0];
      const priceChange = currentPrice - oldest.price;
      const pctChange = Math.abs(priceChange / oldest.price);

      // Calculate "significance score" - price change weighted by market size
      // A 15% move on a 20k volume market = 3000 significance
      // A 15% move on a 2k volume market = 300 significance
      const significanceScore = pctChange * volume;
      const isHighVolume = volume >= botSettings.min_volume_for_alert;
      const isVeryHighVolume = volume >= botSettings.min_volume_for_auto_buy;

      if (pctChange >= PRICE_ALERT_THRESHOLD && oldest.price < 0.90) {
        const direction = priceChange > 0 ? "UP" : "DOWN";

        // Only alert on markets with meaningful volume
        if (!isHighVolume) {
          console.log(`[PRICE] ${market.player_name}: ${direction} ${(pctChange * 100).toFixed(1)}% but low volume (${volume}) - ignoring`);
          priceHistory[ticker] = [{ price: currentPrice, timestamp: now }];
          continue;
        }

        console.log(`\n[PRICE ALERT] ${market.player_name}: ${direction} ${(pctChange * 100).toFixed(1)}% in ${Math.round((now - oldest.timestamp) / 1000)}s`);
        console.log(`[PRICE ALERT] ${(oldest.price * 100).toFixed(0)}¢ -> ${(currentPrice * 100).toFixed(0)}¢ | Volume: ${volume.toLocaleString()} | OI: ${openInterest.toLocaleString()}`);
        console.log(`[PRICE ALERT] Significance score: ${significanceScore.toFixed(0)}`);

        // If price jumped UP significantly on a high-volume market, someone might have info
        const spikeThreshold = botSettings.price_spike_threshold / 100;
        if (priceChange > 0 && pctChange >= spikeThreshold) {
          const volumeLabel = isVeryHighVolume ? "HIGH VOLUME" : "MEDIUM VOLUME";

          // Notify about price spike with volume context
          await sendTelegramNotification(
            `📊 <b>PRICE SPIKE (${volumeLabel})</b>\n\n` +
            `Player: <b>${market.player_name}</b>\n` +
            `Move: ${(oldest.price * 100).toFixed(0)}¢ → ${(currentPrice * 100).toFixed(0)}¢\n` +
            `Change: +${(pctChange * 100).toFixed(1)}%\n` +
            `Volume: ${volume.toLocaleString()}\n` +
            `Open Interest: ${openInterest.toLocaleString()}\n\n` +
            (isVeryHighVolume
              ? `🚨 Significant money moved this market - likely informed buying`
              : `⚠️ Moderate volume spike - could be informed, watch closely`)
          );

          // Only auto-buy on high-volume markets if price spike trading is enabled
          if (isVeryHighVolume && botSettings.features.price_spike_trading) {
            console.log(`[PRICE ALERT] High volume (${volume}) - auto-buying`);
            await handlePriceSpike(market, oldest.price, currentPrice);
          } else if (isVeryHighVolume && !botSettings.features.price_spike_trading) {
            console.log(`[PRICE ALERT] High volume (${volume}) - price spike trading DISABLED in settings`);
          } else {
            console.log(`[PRICE ALERT] Medium volume (${volume}) - alert only, no auto-buy`);
          }
        }

        // Store alert in database with volume data
        await supabase.from("signals").insert({
          market_id: ticker,
          signal_type: "price_movement",
          meta: {
            player_name: market.player_name,
            old_price: oldest.price,
            new_price: currentPrice,
            pct_change: pctChange,
            direction,
            volume,
            open_interest: openInterest,
            significance_score: significanceScore,
            source: "orderbook_monitor",
          },
        });

        // Clear history after alert to avoid repeated alerts
        priceHistory[ticker] = [{ price: currentPrice, timestamp: now }];
      }
    }
  }
}

async function handlePriceSpike(market: TradeMarket, oldPrice: number, newPrice: number): Promise<void> {
  const pctJump = (newPrice - oldPrice) / oldPrice;
  const priceCents = Math.round(newPrice * 100);
  const oldPriceCents = Math.round(oldPrice * 100);
  const absoluteMoveCents = priceCents - oldPriceCents;

  // PROTECTION 1: Ignore tiny markets - percentage changes are misleading
  // A 3¢ → 4¢ move is +33% but just noise. Require price to be at least 20¢
  if (newPrice < 0.20) {
    console.log(`[PRICE SPIKE] ${market.player_name} at ${priceCents}¢ - too cheap, ignoring (need 20¢+ to trade)`);
    return;
  }

  // PROTECTION 2: Require meaningful ABSOLUTE move, not just percentage
  // At least 5¢ move to be considered real signal
  if (absoluteMoveCents < 5) {
    console.log(`[PRICE SPIKE] ${market.player_name} only moved ${absoluteMoveCents}¢ - need 5¢+ absolute move`);
    return;
  }

  // PROTECTION 3: Don't buy if price is already very high (uses dynamic setting)
  const maxEntry = botSettings.price_spike_max_entry / 100;
  if (newPrice >= maxEntry) {
    console.log(`[PRICE SPIKE] ${market.player_name} at ${priceCents}¢ - too expensive (max ${botSettings.price_spike_max_entry}¢ for spike auto-buy)`);
    return;
  }

  // PROTECTION 4: Don't buy if price has already run up massively (late to the party)
  const history = priceHistory[market.ticker] ?? [];
  if (history.length > 0) {
    const sessionLow = Math.min(...history.map(h => h.price));
    const runUpFromLow = (newPrice - sessionLow) / sessionLow;
    if (runUpFromLow > 0.40) {
      console.log(`[PRICE SPIKE] ${market.player_name} already up ${(runUpFromLow * 100).toFixed(0)}% from session low (${(sessionLow * 100).toFixed(0)}¢) - too late`);
      return;
    }
  }

  // PROTECTION 5: Require minimum spike threshold (from settings)
  const spikeThreshold = botSettings.price_spike_threshold / 100;
  if (pctJump < spikeThreshold) {
    return;
  }

  // Use position limit from settings, scaled by price
  // At lower prices we can take bigger positions, at higher prices smaller
  const priceAdjustedPct = Math.max(0.15, 0.50 - (newPrice * 0.55));
  const baseContracts = botSettings.price_spike_position_limit;
  const contracts = Math.round(baseContracts * priceAdjustedPct);

  console.log(`[PRICE SPIKE] Auto-buying ${contracts} contracts of ${market.player_name} (${priceCents}¢, +${absoluteMoveCents}¢ move, limit: ${baseContracts})`);

  const spikeSignal: TradeSignal = {
    player: market.player_name,
    team: null,
    confidence: CONFIDENCE_TIERS.SERIOUS,
    confidence_score: 60,
    tweet: {
      id: `spike-${Date.now()}`,
      text: `Price spike detected: ${(oldPrice * 100).toFixed(0)}¢ -> ${priceCents}¢`,
      author: "price_monitor",
      created_at: new Date().toISOString(),
    },
  };

  // Record the event for timeline
  await recordMarketEvent(
    market.ticker,
    market.player_name,
    "price_spike_buy",
    `Auto-bought on ${(pctJump * 100).toFixed(1)}% spike: ${(oldPrice * 100).toFixed(0)}¢ → ${priceCents}¢`,
    { oldPrice, newPrice, pctJump, contracts }
  );

  await placeOrder(market.ticker, "yes", "buy", contracts, botSettings.price_spike_max_entry, spikeSignal);
}

// =============================================================================
// ORDERBOOK DEPTH MONITORING
// =============================================================================

type OrderbookSnapshot = {
  yes_bid_depth: number;  // Total contracts at bid
  yes_ask_depth: number;  // Total contracts at ask
  no_bid_depth: number;   // Total NO contracts at bid
  no_ask_depth: number;   // Total NO contracts at ask
  spread: number;
  timestamp: number;
};

const orderbookHistory: Record<string, OrderbookSnapshot[]> = {};
const LARGE_ORDER_THRESHOLD = 2000; // Contracts - raised from 500 to reduce noise

async function monitorOrderbook(ticker: string): Promise<void> {
  try {
    const path = `/trade-api/v2/markets/${ticker}/orderbook`;
    const headers = await getKalshiHeaders("GET", path);
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });

    if (!response.ok) return;

    const data = await response.json();
    const orderbook = data.orderbook;

    // Calculate depth for both YES and NO sides
    let yesBidDepth = 0;
    let yesAskDepth = 0;
    let noBidDepth = 0;
    let noAskDepth = 0;

    // YES orderbook: bids are people wanting to buy YES, offers are selling YES
    for (const [price, count] of orderbook?.yes ?? []) {
      yesBidDepth += count;
    }
    // NO orderbook: bids are people wanting to buy NO
    for (const [price, count] of orderbook?.no ?? []) {
      noBidDepth += count;
    }
    // Note: In Kalshi, buying YES = selling NO and vice versa
    // So YES ask depth ≈ NO bid depth and NO ask depth ≈ YES bid depth
    yesAskDepth = noBidDepth;
    noAskDepth = yesBidDepth;

    const now = Date.now();

    if (!orderbookHistory[ticker]) {
      orderbookHistory[ticker] = [];
    }

    const prevSnapshot = orderbookHistory[ticker][orderbookHistory[ticker].length - 1];

    // Detect significant price-impacting volume
    // In a binary market, every transaction affects both sides of the orderbook
    // We only want to report NET direction to avoid duplicate notifications
    if (prevSnapshot) {
      const market = tradeMarkets.find(m => m.ticker === ticker) ?? nextTeamMarkets.find(m => m.ticker === ticker);
      const yesPrice = market?.yes_price ? Math.round(market.yes_price * 100) : 50;

      // Calculate volume changes on both sides
      const yesAskConsumed = Math.max(0, prevSnapshot.yes_ask_depth - yesAskDepth); // Bullish pressure
      const noAskConsumed = Math.max(0, prevSnapshot.no_ask_depth - noAskDepth);   // Bearish pressure

      // Calculate NET direction - only report if there's a clear dominant direction
      const netBullish = yesAskConsumed - noAskConsumed;
      const netBearish = noAskConsumed - yesAskConsumed;

      // Only notify if net volume exceeds threshold AND is clearly one-sided (>2x)
      if (netBullish > LARGE_ORDER_THRESHOLD && yesAskConsumed > noAskConsumed * 2) {
        console.log(`\n[ORDERBOOK] 📈 NET BULLISH on ${market?.player_name ?? ticker}: +${netBullish} contracts, price at ${yesPrice}¢`);

        await sendTelegramNotification(
          `📈 <b>BULLISH VOLUME SPIKE</b>\n\n` +
          `Player: <b>${market?.player_name ?? ticker}</b>\n` +
          `Net Volume: +${netBullish} contracts\n` +
          `YES Price: ${yesPrice}¢\n\n` +
          `🔥 Net buying pressure UP\n` +
          `Could indicate insider activity`
        );

        await supabase.from("signals").insert({
          market_id: ticker,
          signal_type: "volume_spike",
          meta: {
            player_name: market?.player_name,
            direction: "bullish",
            contracts: netBullish,
            price: yesPrice,
            source: "orderbook_monitor",
          },
        });
      } else if (netBearish > LARGE_ORDER_THRESHOLD && noAskConsumed > yesAskConsumed * 2) {
        console.log(`\n[ORDERBOOK] 📉 NET BEARISH on ${market?.player_name ?? ticker}: -${netBearish} contracts, price at ${yesPrice}¢`);

        await sendTelegramNotification(
          `📉 <b>BEARISH VOLUME SPIKE</b>\n\n` +
          `Player: <b>${market?.player_name ?? ticker}</b>\n` +
          `Net Volume: -${netBearish} contracts\n` +
          `YES Price: ${yesPrice}¢\n\n` +
          `⚠️ Net selling pressure DOWN\n` +
          `Trade may be less likely or profit-taking`
        );

        await supabase.from("signals").insert({
          market_id: ticker,
          signal_type: "volume_spike",
          meta: {
            player_name: market?.player_name,
            direction: "bearish",
            contracts: netBearish,
            price: yesPrice,
            source: "orderbook_monitor",
          },
        });
      }
      // If volumes are similar (within 2x), don't notify - it's just normal trading
    }

    orderbookHistory[ticker].push({
      yes_bid_depth: yesBidDepth,
      yes_ask_depth: yesAskDepth,
      no_bid_depth: noBidDepth,
      no_ask_depth: noAskDepth,
      spread: 0,
      timestamp: now,
    });

    // Keep only last 10 snapshots
    if (orderbookHistory[ticker].length > 10) {
      orderbookHistory[ticker].shift();
    }
  } catch (e) {
    // Silently fail - orderbook monitoring is supplementary
  }
}

async function monitorAllOrderbooks(): Promise<void> {
  // Check feature toggle
  if (!botSettings.features.orderbook_monitoring) {
    return;
  }

  // Only monitor "hot" markets (between 30-90%) to save API calls
  const hotTradeMarkets = tradeMarkets.filter(
    (m) => m.yes_price && m.yes_price >= 0.30 && m.yes_price < 0.90
  );

  // Also monitor next team markets in the same price range
  const hotNextTeamMarkets = nextTeamMarkets.filter(
    (m) => m.yes_price && m.yes_price >= 0.30 && m.yes_price < 0.90
  );

  // Combine all hot markets
  const allHotMarkets = [...hotTradeMarkets, ...hotNextTeamMarkets];

  console.log(`[ORDERBOOK] Monitoring ${allHotMarkets.length} hot markets (${hotTradeMarkets.length} trade, ${hotNextTeamMarkets.length} next team)...`);

  for (const market of allHotMarkets.slice(0, 15)) { // Limit to top 15
    await monitorOrderbook(market.ticker);
    await new Promise((r) => setTimeout(r, 100)); // Rate limit
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

function findTradeMarket(playerName: string): TradeMarket | null {
  const searchName = normalizeName(playerName);

  // Exact match first (most reliable)
  for (const market of tradeMarkets) {
    if (normalizeName(market.player_name) === searchName) return market;
  }

  // Partial match on last name - require FULL first name match, not just initial
  // This prevents "Lonzo Ball" matching "LaMelo Ball"
  for (const market of tradeMarkets) {
    const marketWords = normalizeName(market.player_name).split(" ");
    const searchWords = searchName.split(" ");
    const marketLast = marketWords[marketWords.length - 1] ?? "";
    const searchLast = searchWords[searchWords.length - 1] ?? "";
    const marketFirst = marketWords[0] ?? "";
    const searchFirst = searchWords[0] ?? "";

    // Match if last names are the same AND first names are the same
    if (marketLast.length >= 4 && marketLast === searchLast && marketFirst === searchFirst) {
      console.log(`[MARKET] Partial match: "${playerName}" -> "${market.player_name}"`);
      return market;
    }
  }

  // NO fuzzy matching - too risky for financial trades
  // If we can't find exact or near-exact match, return null
  console.log(`[MARKET] No exact match found for: "${playerName}"`);
  return null;
}

function findNextTeamMarket(playerName: string, teamName: string): NextTeamMarket | null {
  const searchPlayer = playerName.toLowerCase();
  const searchTeam = teamName.toLowerCase();

  // Get team code
  let teamCode = TEAM_CODES[searchTeam];
  if (!teamCode) {
    for (const [key, code] of Object.entries(TEAM_CODES)) {
      if (searchTeam.includes(key)) {
        teamCode = code;
        break;
      }
    }
  }

  if (!teamCode) {
    console.log(`[MARKET] Unknown team: ${teamName}`);
    return null;
  }

  for (const market of nextTeamMarkets) {
    const marketPlayer = market.player_name.toLowerCase();
    const playerMatch = marketPlayer === searchPlayer ||
      marketPlayer.split(" ").pop() === searchPlayer.split(" ").pop();

    if (playerMatch && market.team_code === teamCode) {
      return market;
    }
  }

  return null;
}

// =============================================================================
// TWEET PARSING
// =============================================================================

type Tweet = {
  id: string;
  text: string;
  author: string;
  created_at: string;
};

type TradeSignal = {
  player: string;
  team: string | null;  // Destination team (if known)
  confidence: ConfidenceTier;
  confidence_score: number;  // 0-100 from LLM or default
  tweet: Tweet;
  llm_analysis_id?: number;  // Reference to llm_analyses table for audit trail
};

// Known NBA player names for better matching
const KNOWN_PLAYERS = [
  // Stars and high-profile trade targets
  "James Harden", "Darius Garland", "Giannis Antetokounmpo", "Ja Morant",
  "Jaren Jackson Jr", "Jonathan Kuminga", "Klay Thompson", "Karl-Anthony Towns",
  "Tyler Herro", "Coby White", "Zach LaVine", "RJ Barrett", "Pascal Siakam",
  "Domantas Sabonis", "Benedict Mathurin", "Kyle Kuzma", "Chris Paul",
  "Anthony Davis", "LaMelo Ball", "Zion Williamson", "Paul George",
  "Kawhi Leonard", "Lauri Markkanen", "Nikola Vucevic", "Jaden Ivey",
  "Mike Conley", "Tobias Harris", "Nic Claxton", "Michael Porter Jr",
  "Grayson Allen", "Trey Murphy", "Herbert Jones", "Daniel Gafford",
  "Donte DiVincenzo", "Ivica Zubac", "Malik Monk", "Dyson Daniels",
  // Additional trade targets
  "Jimmy Butler", "Brandon Ingram", "Bradley Beal", "De'Aaron Fox",
  "Dejounte Murray", "Scottie Barnes", "Jalen Brunson", "Donovan Mitchell",
  "Devin Booker", "Trae Young", "Tyrese Haliburton", "Jaylen Brown",
  "Jayson Tatum", "Bam Adebayo", "Julius Randle", "OG Anunoby",
  "Bruce Brown", "Cameron Johnson", "Mikal Bridges", "Jerami Grant",
  "Bobby Portis", "Brook Lopez", "Alex Caruso", "Demar DeRozan",
  "Rudy Gobert", "Jakob Poeltl", "Harrison Barnes", "Norman Powell",
  "Marcus Smart", "Terry Rozier", "Monte Morris", "Cam Reddish",
  "Keldon Johnson", "Walker Kessler", "Keegan Murray", "Onyeka Okongwu",
];

const PLAYER_PATTERNS = [
  /trading\s+(?:center\s+|forward\s+|guard\s+|star\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)/gi,
  /([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)\s+(?:has been|is being|will be)\s+traded/gi,
  /(?:acquiring|acquired)\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)/gi,
  /sends?\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)/gi,
  /deal\s+(?:that\s+)?sends?\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)/gi,
  /landing\s+(?:.*?\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)/gi,
  /([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)\s+(?:traded|dealt)\s+to/gi,
  /conversations?\s+on\s+(?:a\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+)/gi,
  /discussing\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/gi,
  // Package deal patterns - capture multiple players
  /([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)[,\s]+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)\s+package/gi,
  /package\s+(?:with|of|including)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/gi,
  /([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)\s+and\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+Jr\.?)?)/gi,
];

const TEAM_PATTERNS = [
  /traded\s+to\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  /acquiring\s+.+?\s+from\s+(?:the\s+)?([A-Z][a-z]+)/i,
  /to\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+for/i,
  /landing\s+.+?\s+from\s+(?:the\s+)?([A-Z][a-z]+)/i,
  /(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:are|is)\s+acquiring/i,
  /deal\s+with\s+(?:the\s+)?([A-Z][a-z]+)/i,
];

async function extractSignalsWithLLM(tweet: Tweet): Promise<{ signals: TradeSignal[]; analysisId?: number }> {
  const signals: TradeSignal[] = [];

  // Try LLM analysis first (more accurate)
  const llmAnalysis = await analyzeWithLLM(tweet.text, tweet.author, tweet.id);

  if (llmAnalysis && llmAnalysis.players.length > 0) {
    console.log(`[LLM] Analysis for tweet from @${tweet.author}:`);

    // Send Telegram notification for trade-relevant tweets
    const playerSummaries = llmAnalysis.players.map(p => {
      const emoji = p.confidence === "confirmed" ? "🚨" :
                    p.confidence === "imminent" ? "⚡" :
                    p.confidence === "serious" ? "📈" :
                    p.confidence === "negative" ? "📉" : "👀";
      return `${emoji} <b>${p.name}</b>: ${p.confidence} (${p.sentiment_score >= 0 ? "+" : ""}${p.sentiment_score})\n   └ ${p.reasoning}`;
    }).join("\n");

    await sendTelegramNotification(
      `📰 <b>TRADE TWEET DETECTED</b>\n\n` +
      `Source: @${tweet.author}\n` +
      `"${tweet.text.substring(0, 150)}${tweet.text.length > 150 ? "..." : ""}"\n\n` +
      `<b>Analysis:</b>\n${playerSummaries}`
    );

    for (const player of llmAnalysis.players) {
      // Map LLM confidence to our tiers
      const tierMap: Record<string, ConfidenceTier> = {
        confirmed: CONFIDENCE_TIERS.CONFIRMED,
        imminent: CONFIDENCE_TIERS.IMMINENT,
        serious: CONFIDENCE_TIERS.SERIOUS,
        exploring: CONFIDENCE_TIERS.EXPLORING,
        negative: CONFIDENCE_TIERS.NEGATIVE,
      };

      const confidence = tierMap[player.confidence] ?? CONFIDENCE_TIERS.EXPLORING;

      console.log(`[LLM]   ${player.name}: ${player.confidence} - ${player.reasoning}`);

      // Skip exploring tier
      if (confidence.level === 4) continue;

      // Only create signal if player is actually being traded OR it's negative news
      if (player.is_being_traded || player.confidence === "negative") {
        signals.push({
          player: player.name,
          team: player.destination_team ?? null,
          confidence,
          confidence_score: player.confidence_score ?? 70,
          tweet,
          llm_analysis_id: llmAnalysis.analysis_id,
        });
      }
    }

    return { signals, analysisId: llmAnalysis.analysis_id };
  }

  // Fall back to keyword matching if LLM fails
  console.log(`[LLM] Falling back to keyword matching`);
  return { signals: extractSignalsKeyword(tweet), analysisId: undefined };
}

function extractSignalsKeyword(tweet: Tweet): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const text = tweet.text;
  const confidence = classifyConfidence(text);

  // Don't generate signals for "exploring" tier
  if (confidence.level === 4) return signals;

  const players: string[] = [];
  const falsePositives = ["The Bulls", "The Lakers", "Pro Basketball", "NBA Today", "All Star", "star forward", "star guard", "star center"];

  // First, check for known players directly in the text (most reliable)
  for (const knownPlayer of KNOWN_PLAYERS) {
    if (text.includes(knownPlayer) || text.toLowerCase().includes(knownPlayer.toLowerCase())) {
      players.push(knownPlayer);
    }
    // Also check without "Jr" suffix
    const withoutJr = knownPlayer.replace(/ Jr\.?$/, "");
    if (withoutJr !== knownPlayer && text.includes(withoutJr)) {
      players.push(knownPlayer);
    }
  }

  // Then use regex patterns to catch any we missed
  for (const pattern of PLAYER_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // Check all capture groups
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          const player = match[i].trim();
          if (!falsePositives.some(fp => player.toLowerCase().includes(fp.toLowerCase()))) {
            players.push(player);
          }
        }
      }
    }
  }

  // Extract destination team (if mentioned)
  let destTeam: string | null = null;
  for (const pattern of TEAM_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const team = match[1].trim().toLowerCase();
      if (TEAM_CODES[team] || Object.keys(TEAM_CODES).some(k => k.includes(team) || team.includes(k))) {
        destTeam = match[1].trim();
        break;
      }
    }
  }

  // Deduplicate players (case-insensitive)
  const seen = new Set<string>();
  const uniquePlayers: string[] = [];
  for (const player of players) {
    const key = player.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniquePlayers.push(player);
    }
  }

  // First, try to identify the ACTUAL trade target (who was acquired)
  const actualTarget = extractActualTradeTarget(text);

  // Create signals for each player with context-aware confidence
  for (const player of uniquePlayers) {
    // Check if this player is mentioned in a NEGATIVE context
    const isNegative = isNegativeContextForPlayer(text, player);

    // Determine the confidence for THIS specific player
    let playerConfidence = confidence;

    if (isNegative) {
      // Player was passed over / mentioned as alternative - NEGATIVE signal
      console.log(`[CONTEXT] ${player} mentioned in NEGATIVE context (passed over/alternative)`);
      playerConfidence = CONFIDENCE_TIERS.NEGATIVE;
    } else if (actualTarget && actualTarget.player.toLowerCase() !== player.toLowerCase()) {
      // A different player was the actual trade target
      // This player is just mentioned, not traded - skip or mark as exploring
      console.log(`[CONTEXT] ${player} mentioned but ${actualTarget.player} is actual trade target - skipping`);
      continue;
    }

    // Default confidence scores by tier for keyword matching
    const tierScores: Record<string, number> = {
      Confirmed: 95, Imminent: 80, Serious: 60, Exploring: 30, Negative: 70
    };
    signals.push({
      player,
      team: destTeam,
      confidence: playerConfidence,
      confidence_score: tierScores[playerConfidence.name] ?? 50,
      tweet,
    });
  }

  return signals;
}

// =============================================================================
// ORDER EXECUTION
// =============================================================================

async function getOrderbook(ticker: string): Promise<{ yes_ask: number | null; no_ask: number | null }> {
  const path = `/trade-api/v2/markets/${ticker}/orderbook`;
  const headers = await getKalshiHeaders("GET", path);

  try {
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });
    if (!response.ok) return { yes_ask: null, no_ask: null };

    const data = await response.json();
    let yes_ask: number | null = null;
    let no_ask: number | null = null;

    if (data.orderbook?.no?.length > 0) {
      const noBid = data.orderbook.no[0][0];
      yes_ask = 100 - noBid;
    }
    if (data.orderbook?.yes?.length > 0) {
      const yesBid = data.orderbook.yes[0][0];
      no_ask = 100 - yesBid;
    }

    return { yes_ask, no_ask };
  } catch (e) {
    console.error(`[ORDERBOOK] Error for ${ticker}:`, e);
    return { yes_ask: null, no_ask: null };
  }
}

// Deduplication: track recent buys to prevent buying same player from multiple sources
const recentBuys: Map<string, number> = new Map(); // ticker -> timestamp
const DEDUP_COOLDOWN_MS = 300000; // 5 minutes - don't buy same player twice in 5 min

// KILL SWITCH - disable all NBA trading until bugs are fully verified
const NBA_TRADING_DISABLED = true;

async function placeOrder(
  ticker: string,
  side: "yes" | "no",
  action: "buy" | "sell",
  count: number,
  maxPrice: number,
  signal: TradeSignal
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  // KILL SWITCH - block all trades
  if (NBA_TRADING_DISABLED) {
    console.log(`[ORDER] ⛔ TRADING DISABLED - would have ${action} ${count} ${side} on ${ticker} @ ${maxPrice}¢`);
    return { success: false, error: "Trading disabled" };
  }

  // Deduplication check for buys
  if (action === "buy") {
    const lastBuy = recentBuys.get(ticker);
    const now = Date.now();
    if (lastBuy && now - lastBuy < DEDUP_COOLDOWN_MS) {
      const secsAgo = Math.round((now - lastBuy) / 1000);
      console.log(`[ORDER] SKIP (dedup): Already bought ${ticker} ${secsAgo}s ago, waiting ${Math.round((DEDUP_COOLDOWN_MS - (now - lastBuy)) / 1000)}s`);
      return { success: false, error: `Dedup: bought ${secsAgo}s ago` };
    }
  }

  console.log(`[ORDER] ${action.toUpperCase()} ${count} ${side.toUpperCase()} on ${ticker}...`);

  const { yes_ask, no_ask } = await getOrderbook(ticker);
  const currentAsk = side === "yes" ? yes_ask : no_ask;

  // Also get last traded price from our market cache as backup
  // IMPORTANT: Convert to the correct side's price (YES price vs NO price = 100 - YES price)
  const cachedMarket = tradeMarkets.find(m => m.ticker === ticker) ?? nextTeamMarkets.find(m => m.ticker === ticker);
  const yesPrice = cachedMarket?.yes_price ? Math.round(cachedMarket.yes_price * 100) : null;
  const lastPrice = yesPrice !== null ? (side === "yes" ? yesPrice : 100 - yesPrice) : null;

  // Calculate price based on action (buy vs sell)
  let price: number;
  const SLIPPAGE = 3; // cents for slippage

  // Use best available price info, but sanity check orderbook vs last price
  // For thin markets, orderbook ask can be wildly different from last traded price
  let referencePrice: number | null = null;
  if (currentAsk !== null && lastPrice !== null) {
    // If orderbook ask is more than 20c away from last price, trust last price
    if (Math.abs(currentAsk - lastPrice) > 20) {
      console.log(`[ORDER] Orderbook (${currentAsk}c) far from last price (${lastPrice}c), using last price`);
      referencePrice = lastPrice;
    } else {
      referencePrice = currentAsk;
    }
  } else {
    referencePrice = currentAsk ?? lastPrice;
  }

  if (action === "sell") {
    // SELLING: For high-probability markets (95%+), sell at market price - no discount
    if (referencePrice !== null) {
      if (referencePrice >= 95) {
        // Confirmed/certain win - sell at market price, no slippage
        price = referencePrice;
        console.log(`[ORDER] SELL at ${price}c (certain win, no slippage)`);
      } else {
        // Lower probability - small slippage to ensure fill
        price = Math.max(referencePrice - 1, 1);
        console.log(`[ORDER] SELL at ${price}c (market: ${referencePrice}c)`);
      }
    } else {
      // No price data - sell at maxPrice as floor
      price = maxPrice;
      console.log(`[ORDER] WARNING: No price data for ${ticker}, selling at ${price}c`);
    }
  } else {
    // BUYING: Don't overpay - skip if market > maxPrice
    if (referencePrice !== null) {
      // Skip if market is at 98¢+ - no profit potential even on confirmed trades
      if (referencePrice >= 98) {
        console.log(`[ORDER] SKIP: Market already at ${referencePrice}c - no profit edge`);
        return { success: false, error: `Market at ${referencePrice}c - already priced in` };
      }

      if (referencePrice > maxPrice) {
        // Market is above our max - skip to avoid overpaying
        console.log(`[ORDER] SKIP: Market ${referencePrice}c > max ${maxPrice}c for ${signal.confidence.name} tier`);

        // Notify about skipped order
        await sendTelegramNotification(
          `⏭️ <b>ORDER SKIPPED</b>\n\n` +
          `Player: <b>${signal.player}</b>\n` +
          `Reason: Market ${referencePrice}¢ > max ${maxPrice}¢\n` +
          `Tier: ${signal.confidence.name}\n\n` +
          `💡 Price too high for auto-buy. Manual review?`
        );

        return { success: false, error: `Market ${referencePrice}c > tier max ${maxPrice}c` };
      }

      // AGGRESSIVE PRICING for Confirmed tier - bid at maxPrice to ensure fill
      // When news breaks, prices rocket in seconds. Small slippage means missed trades.
      // We'll pay market price (whatever matches first), but won't miss the opportunity.
      if (signal.confidence.name === "Confirmed") {
        price = maxPrice;
        console.log(`[ORDER] CONFIRMED TIER: Aggressive bid at ${price}c to ensure fill (market: ${referencePrice}c)`);
      } else if (signal.confidence.name === "Imminent") {
        // Imminent also gets more aggressive - bid halfway between market and max
        price = Math.min(Math.round((referencePrice + maxPrice) / 2), maxPrice);
        console.log(`[ORDER] IMMINENT TIER: Semi-aggressive bid at ${price}c (market: ${referencePrice}c, max: ${maxPrice}c)`);
      } else {
        // Other tiers - normal slippage
        price = Math.min(referencePrice + SLIPPAGE, maxPrice);
      }
    } else {
      // No price data at all - use maxPrice (risky but only option)
      console.log(`[ORDER] WARNING: No price data for ${ticker}, using max ${maxPrice}c`);
      price = maxPrice;
    }
  }

  console.log(`[ORDER] ${ticker}: ${count} ${side.toUpperCase()} @ ${price}c (ask: ${currentAsk ?? "N/A"}c, last: ${lastPrice ?? "N/A"}c, max: ${maxPrice}c)`);

  const order = {
    ticker,
    side,
    action,
    type: "limit",
    count,
    [`${side}_price`]: price,
    client_order_id: `nba-v2-${signal.tweet.id}-${Date.now()}`,
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
      console.error(`[ORDER] Failed: ${response.status} - ${JSON.stringify(result)}`);
      return { success: false, error: JSON.stringify(result) };
    }

    console.log(`[ORDER] ✅ SUCCESS! Order ID: ${result.order.order_id}, Status: ${result.order.status}`);

    // Track this buy for deduplication
    if (action === "buy") {
      recentBuys.set(ticker, Date.now());
      // Clean up old entries
      const now = Date.now();
      for (const [t, ts] of recentBuys) {
        if (now - ts > DEDUP_COOLDOWN_MS) recentBuys.delete(t);
      }
    }

    // Send Telegram notification
    const emoji = side === "yes" ? "🟢" : "🔴";
    const tierEmoji = signal.confidence.name === "Confirmed" ? "🚨" :
                      signal.confidence.name === "Imminent" ? "⚡" :
                      signal.confidence.name === "Serious" ? "📈" : "📊";
    await sendTelegramNotification(
      `${tierEmoji} <b>NBA TRADE BOT</b>\n\n` +
      `${emoji} <b>${action.toUpperCase()} ${count} ${side.toUpperCase()}</b>\n` +
      `Player: <b>${signal.player}</b>\n` +
      `Price: ${price}¢\n` +
      `Tier: ${signal.confidence.name}\n` +
      `Status: ${result.order.status}\n\n` +
      `Source: @${signal.tweet.author}\n` +
      `"${signal.tweet.text.substring(0, 100)}..."`
    );

    // Record trade with optional llm_analysis_id for audit trail
    await supabase.from("trades").insert({
      market_ticker: ticker,
      order_id: result.order.order_id,
      side,
      action,
      price_cents: price,
      contract_count: count,
      status: result.order.status,
      llm_analysis_id: signal.llm_analysis_id ?? null,
      meta: {
        player_name: signal.player,
        team: signal.team,
        confidence_tier: signal.confidence.name,
        tweet_id: signal.tweet.id,
        tweet_author: signal.tweet.author,
      },
    });

    return { success: true, orderId: result.order.order_id };
  } catch (e) {
    console.error(`[ORDER] Exception:`, e);
    return { success: false, error: String(e) };
  }
}

// Get all current positions from Kalshi
async function getAllPositions(): Promise<Array<{ ticker: string; contracts: number; side: string }>> {
  try {
    const path = "/trade-api/v2/portfolio/positions";
    const headers = await getKalshiHeaders("GET", path);
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });

    if (!response.ok) return [];

    const data = await response.json();
    const positions: Array<{ ticker: string; contracts: number; side: string }> = [];

    for (const p of data.market_positions ?? []) {
      // Kalshi has separate position (YES) and no_position (NO) fields
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
  } catch (e) {
    console.error("[POSITIONS] Error fetching positions:", e);
    return [];
  }
}

// Track pending sell orders to avoid retrying (in-memory cache)
const pendingSellOrders: Set<string> = new Set();

// Fetch actual resting orders from Kalshi to avoid duplicate sell attempts
async function getRestingOrders(): Promise<Set<string>> {
  const restingTickers = new Set<string>();
  try {
    const ordersPath = "/trade-api/v2/portfolio/orders";
    const headers = await getKalshiHeaders("GET", ordersPath);
    const resp = await fetch(`https://api.elections.kalshi.com${ordersPath}?status=resting`, { headers });
    const data = await resp.json();

    for (const order of data.orders || []) {
      // Track tickers with resting sell orders
      if (order.action === "sell" && order.status === "resting") {
        restingTickers.add(order.ticker);
      }
    }
  } catch (e) {
    console.error("[PROFIT] Error fetching resting orders:", e);
  }
  return restingTickers;
}

// =============================================================================
// DEADLINE COUNTDOWN - AUTO-BUY NOs
// =============================================================================

// Track which tickers we've already bought NO on to avoid double-buying
const deadlineNoBuysExecuted = new Set<string>();

// Check for recent signals on a player (within last 30 minutes)
async function hasRecentSignal(playerName: string): Promise<boolean> {
  try {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("source_predictions")
      .select("*")
      .eq("player_name", playerName)
      .gte("created_at", thirtyMinAgo)
      .limit(1);

    return (data?.length ?? 0) > 0;
  } catch (e) {
    console.error(`[DEADLINE] Error checking recent signals for ${playerName}:`, e);
    return true; // Assume there might be signals if we can't check
  }
}

// Auto-buy NOs on players who haven't been traded as deadline approaches
async function checkDeadlineNoBuying(): Promise<void> {
  const deadline = new Date("2026-02-05T20:00:00Z"); // 3pm ET = 8pm UTC
  const now = new Date();
  const minutesUntilDeadline = (deadline.getTime() - now.getTime()) / (1000 * 60);

  // Only run in final 15 minutes
  if (minutesUntilDeadline > 15 || minutesUntilDeadline < 0) {
    return;
  }

  console.log(`\n[DEADLINE] ⏰ ${minutesUntilDeadline.toFixed(1)} MINUTES UNTIL DEADLINE - Scanning for NO opportunities...`);

  // Get all open NBA trade markets
  const marketsToCheck = tradeMarkets.filter(m =>
    m.ticker.startsWith("KXNBATRADE") &&
    !deadlineNoBuysExecuted.has(m.ticker)
  );

  const opportunities: Array<{
    market: typeof tradeMarkets[0];
    noPrice: number;
    yesPrice: number;
    hasRecent: boolean;
  }> = [];

  for (const market of marketsToCheck) {
    const yesPrice = Math.round((market.yes_price ?? 0) * 100);
    const noPrice = 100 - yesPrice;

    // Look for NOs priced below 90¢ (YES above 10¢)
    // These are players the market thinks MIGHT still be traded
    if (noPrice <= 90 && noPrice >= 50) {
      const hasRecent = await hasRecentSignal(market.player_name ?? "");
      opportunities.push({ market, noPrice, yesPrice, hasRecent });
    }
  }

  // Sort by best value (lowest NO price = highest edge)
  opportunities.sort((a, b) => a.noPrice - b.noPrice);

  console.log(`[DEADLINE] Found ${opportunities.length} potential NO plays:`);

  for (const opp of opportunities.slice(0, 10)) {
    const { market, noPrice, yesPrice, hasRecent } = opp;
    const recentStatus = hasRecent ? "⚠️ RECENT SIGNAL" : "✅ NO RECENT SIGNALS";
    console.log(`  ${market.player_name?.padEnd(20) ?? market.ticker} | NO @ ${noPrice}¢ | ${recentStatus}`);

    // Auto-buy criteria:
    // 1. NO price is 85¢ or less (at least 15¢ potential edge)
    // 2. No recent signals in last 30 minutes
    // 3. Haven't already bought
    if (noPrice <= 85 && !hasRecent && !deadlineNoBuysExecuted.has(market.ticker)) {
      const contracts = Math.min(50, BASE_CONTRACT_COUNT); // Cap at 50 contracts per NO bet
      const potentialProfit = ((100 - noPrice) * contracts) / 100;

      console.log(`[DEADLINE] 🎯 AUTO-BUYING NO on ${market.player_name} @ ${noPrice}¢ (${contracts} contracts)`);

      await sendTelegramNotification(
        `⏰ <b>DEADLINE NO BUY</b>\n\n` +
        `Player: <b>${market.player_name}</b>\n` +
        `Time left: <b>${minutesUntilDeadline.toFixed(0)} minutes</b>\n\n` +
        `Buying NO @ ${noPrice}¢\n` +
        `Contracts: ${contracts}\n` +
        `Max profit if NO trade: $${potentialProfit.toFixed(2)}\n\n` +
        `Rationale: No recent Twitter signals, deadline imminent`
      );

      // Place the NO order
      const dummySignal: TradeSignal = {
        player: market.player_name ?? "Unknown",
        team: null,
        confidence: CONFIDENCE_TIERS.CONFIRMED,
        confidence_score: 95,
        tweet: {
          id: "deadline-no-buy",
          text: `Deadline NO buy - ${minutesUntilDeadline.toFixed(0)}min left`,
          author: "system",
          created_at: new Date().toISOString()
        },
      };

      await placeOrder(market.ticker, "no", "buy", contracts, noPrice, dummySignal);
      deadlineNoBuysExecuted.add(market.ticker);
    }
  }
}

// Smart profit-taking with multiple strategies:
// 1. Full exit at 95%+ (near resolution)
// 2. Partial profit at 30%+ gain (take half off the table)
// 3. Stop-loss at 40%+ loss (cut losers)
// 4. Deadline-aware urgency (sell uncertain positions as deadline approaches)
async function checkProfitTaking(): Promise<void> {
  // Check feature toggle
  if (!botSettings.features.profit_taking) {
    console.log("[PROFIT] Profit-taking disabled in settings");
    return;
  }

  const positions = await getAllPositions();
  if (positions.length === 0) return;

  // Fetch actual resting orders from Kalshi (persists across restarts)
  const restingOrders = await getRestingOrders();

  // Check if we're close to the trade deadline (Feb 6, 3pm ET)
  const deadline = new Date("2026-02-05T20:00:00Z"); // 3pm ET = 8pm UTC
  const now = new Date();
  const hoursUntilDeadline = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
  const isDeadlineDay = hoursUntilDeadline <= 24 && hoursUntilDeadline > 0;
  const isFinalHours = hoursUntilDeadline <= 3 && hoursUntilDeadline > 0;

  console.log(`[PROFIT] Checking ${positions.length} positions (${hoursUntilDeadline.toFixed(1)}h until deadline)...`);

  for (const pos of positions) {
    // Only check NBA trade markets
    if (!pos.ticker.startsWith("KXNBATRADE") && !pos.ticker.startsWith("KXNEXTTEAM")) continue;

    // Get current market price
    const market = tradeMarkets.find(m => m.ticker === pos.ticker) ?? nextTeamMarkets.find(m => m.ticker === pos.ticker);

    // Skip if we already have a resting sell order for this position
    if (restingOrders.has(pos.ticker) || pendingSellOrders.has(pos.ticker)) {
      console.log(`[PROFIT] ${market?.player_name ?? pos.ticker}: Resting sell order exists, skipping`);
      continue;
    }
    const yesPrice = market?.yes_price ?? null;
    if (yesPrice === null) continue;

    const isYesPosition = pos.side === "yes";
    const currentSidePrice = isYesPosition ? yesPrice : (1 - yesPrice);
    const currentPriceCents = Math.round(currentSidePrice * 100);

    // Get our average entry price from Kalshi fills (more reliable than trades table)
    const fillsPath = "/trade-api/v2/portfolio/fills";
    const fillsHeaders = await getKalshiHeaders("GET", fillsPath);
    const fillsResp = await fetch(`https://api.elections.kalshi.com${fillsPath}?ticker=${pos.ticker}&limit=100`, { headers: fillsHeaders });
    const fillsData = await fillsResp.json();

    const buyFills = (fillsData.fills || []).filter((f: any) => f.action === "buy" && f.side === pos.side);
    if (buyFills.length === 0) {
      console.log(`[PROFIT] ${market?.player_name ?? pos.ticker} (${pos.side.toUpperCase()}): No buy fills found, skipping`);
      continue;
    }

    // Calculate average entry price correctly for NO positions
    // Debug: log each fill to understand entry price calculation
    let totalCost = 0;
    let totalContracts = 0;
    console.log(`[PROFIT] ${market?.player_name ?? pos.ticker} fills breakdown:`);
    for (const fill of buyFills) {
      const yp = fill.yes_price ?? 0;
      const actualPrice = pos.side === "no" ? 100 - yp : yp;
      totalCost += actualPrice * fill.count;
      totalContracts += fill.count;
      console.log(`[PROFIT]   - ${fill.count} @ ${actualPrice}¢ (yes_price: ${yp}, date: ${fill.created_time?.substring(0, 10) ?? 'unknown'})`);
    }
    const avgEntryPrice = totalContracts > 0 ? totalCost / totalContracts : 0;
    console.log(`[PROFIT]   = ${totalContracts} total @ avg ${avgEntryPrice.toFixed(1)}¢`);

    const profitPerContract = currentPriceCents - avgEntryPrice;
    const profitPercent = avgEntryPrice > 0 ? (profitPerContract / avgEntryPrice) * 100 : 0;
    const totalProfitDollars = (profitPerContract * pos.contracts) / 100;

    // ========== STRATEGY 1: Full exit at 95%+ (market near resolution) ==========
    if (currentSidePrice >= 0.95 && profitPerContract >= 5) {
      console.log(`[PROFIT] 🎯 NEAR RESOLUTION: ${market?.player_name ?? pos.ticker} at ${currentPriceCents}¢ - FULL EXIT`);

      await sendTelegramNotification(
        `🎯 <b>PROFIT TAKING - NEAR RESOLUTION</b>\n\n` +
        `Player: <b>${market?.player_name ?? pos.ticker}</b>\n` +
        `Side: <b>${pos.side.toUpperCase()}</b>\n` +
        `Entry: ${avgEntryPrice.toFixed(0)}¢ → Now: ${currentPriceCents}¢\n` +
        `Profit: +${profitPercent.toFixed(0)}%\n` +
        `Selling: ALL ${pos.contracts} contracts\n\n` +
        `💵 Locking in: $${totalProfitDollars.toFixed(2)}`
      );

      const sellPrice = Math.max(avgEntryPrice + 3, currentPriceCents - 2);
      await executeSell(pos.ticker, pos.side, pos.contracts, sellPrice, market?.player_name ?? pos.ticker);
      continue;
    }

    // ========== STRATEGY 2: Partial profit at 30%+ gain ==========
    if (profitPercent >= 30 && currentPriceCents >= 60) {
      const sellCount = Math.floor(pos.contracts * 0.5); // Sell half
      if (sellCount >= 5) { // Only if meaningful size
        console.log(`[PROFIT] 💰 PARTIAL PROFIT: ${market?.player_name ?? pos.ticker} +${profitPercent.toFixed(0)}% - selling ${sellCount}/${pos.contracts}`);

        await sendTelegramNotification(
          `💰 <b>PARTIAL PROFIT TAKING</b>\n\n` +
          `Player: <b>${market?.player_name ?? pos.ticker}</b>\n` +
          `Side: <b>${pos.side.toUpperCase()}</b>\n` +
          `Entry: ${avgEntryPrice.toFixed(0)}¢ → Now: ${currentPriceCents}¢\n` +
          `Profit: +${profitPercent.toFixed(0)}%\n` +
          `Selling: ${sellCount} of ${pos.contracts} (50%)\n` +
          `Keeping: ${pos.contracts - sellCount} for upside\n\n` +
          `💵 Locking in: $${((profitPerContract * sellCount) / 100).toFixed(2)}`
        );

        const sellPrice = currentPriceCents - 2;
        await executeSell(pos.ticker, pos.side, sellCount, sellPrice, market?.player_name ?? pos.ticker);
        continue;
      }
    }

    // ========== STRATEGY 3: Stop-loss at 40%+ loss ==========
    if (profitPercent <= -40 && !isFinalHours) {
      console.log(`[PROFIT] 🛑 STOP LOSS: ${market?.player_name ?? pos.ticker} at ${profitPercent.toFixed(0)}% - cutting losses`);

      await sendTelegramNotification(
        `🛑 <b>STOP LOSS TRIGGERED</b>\n\n` +
        `Player: <b>${market?.player_name ?? pos.ticker}</b>\n` +
        `Side: <b>${pos.side.toUpperCase()}</b>\n` +
        `Entry: ${avgEntryPrice.toFixed(0)}¢ → Now: ${currentPriceCents}¢\n` +
        `Loss: ${profitPercent.toFixed(0)}%\n` +
        `Selling: ALL ${pos.contracts} contracts\n\n` +
        `⚠️ Cutting loss: $${Math.abs(totalProfitDollars).toFixed(2)}`
      );

      const sellPrice = currentPriceCents - 3; // Sell aggressively
      await executeSell(pos.ticker, pos.side, pos.contracts, sellPrice, market?.player_name ?? pos.ticker);
      continue;
    }

    // ========== STRATEGY 4: Deadline urgency - sell uncertain positions ==========
    if (isFinalHours && currentSidePrice < 0.60) {
      console.log(`[PROFIT] ⏰ DEADLINE URGENCY: ${market?.player_name ?? pos.ticker} at ${currentPriceCents}¢ - selling before deadline`);

      await sendTelegramNotification(
        `⏰ <b>DEADLINE LIQUIDATION</b>\n\n` +
        `Player: <b>${market?.player_name ?? pos.ticker}</b>\n` +
        `Side: <b>${pos.side.toUpperCase()}</b>\n` +
        `Current: ${currentPriceCents}¢ (${(currentSidePrice * 100).toFixed(0)}% implied)\n` +
        `Entry: ${avgEntryPrice.toFixed(0)}¢\n` +
        `P&L: ${profitPercent >= 0 ? "+" : ""}${profitPercent.toFixed(0)}%\n\n` +
        `⚠️ <${hoursUntilDeadline.toFixed(1)}h until deadline - exiting uncertain position`
      );

      const sellPrice = currentPriceCents - 5; // Very aggressive to ensure fill
      await executeSell(pos.ticker, pos.side, pos.contracts, sellPrice, market?.player_name ?? pos.ticker);
      continue;
    }

    // Log positions we're monitoring but not acting on
    if (Math.abs(profitPercent) > 10) {
      console.log(`[PROFIT] ${market?.player_name ?? pos.ticker} (${pos.side.toUpperCase()}): ${profitPercent >= 0 ? "+" : ""}${profitPercent.toFixed(0)}% (entry: ${avgEntryPrice.toFixed(0)}¢, now: ${currentPriceCents}¢) - monitoring`);
    }
  }
}

// Helper function to execute sells
async function executeSell(ticker: string, side: string, contracts: number, price: number, playerName: string): Promise<void> {
  // Track this pending sell to avoid retrying
  pendingSellOrders.add(ticker);

  // Remove from pending after 5 minutes (either filled or can retry)
  setTimeout(() => {
    pendingSellOrders.delete(ticker);
    console.log(`[PROFIT] Cleared pending sell for ${ticker}`);
  }, 5 * 60 * 1000);

  const dummySignal: TradeSignal = {
    player: playerName,
    team: null,
    confidence: CONFIDENCE_TIERS.CONFIRMED,
    confidence_score: 100,
    tweet: { id: "auto-sell", text: "Smart profit/loss management", author: "system", created_at: new Date().toISOString() },
  };
  await placeOrder(ticker, side as "yes" | "no", "sell", contracts, price, dummySignal);
}

// Check if we have an existing YES position in a market
async function getExistingPosition(ticker: string): Promise<{ contracts: number; avgPrice: number } | null> {
  try {
    const path = `/trade-api/v2/portfolio/positions?ticker=${ticker}`;
    const headers = await getKalshiHeaders("GET", path);
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });

    if (!response.ok) return null;

    const data = await response.json();
    const positions = data.market_positions ?? [];
    const pos = positions.find((p: any) => p.ticker === ticker);

    if (pos && pos.position > 0) {
      return {
        contracts: pos.position,
        avgPrice: Math.round((pos.total_traded / pos.position) * 100),
      };
    }
    return null;
  } catch (e) {
    console.error(`[POSITION] Error checking position for ${ticker}:`, e);
    return null;
  }
}

// Check if we have an existing NO position in a market
async function getExistingNoPosition(ticker: string): Promise<{ contracts: number; avgPrice: number } | null> {
  try {
    const path = `/trade-api/v2/portfolio/positions?ticker=${ticker}`;
    const headers = await getKalshiHeaders("GET", path);
    const response = await fetch(`https://api.elections.kalshi.com${path}`, { headers });

    if (!response.ok) return null;

    const data = await response.json();
    const positions = data.market_positions ?? [];
    const pos = positions.find((p: any) => p.ticker === ticker);

    // Check for NO position (negative position value or explicit no_position field)
    if (pos && pos.no_position && pos.no_position > 0) {
      return {
        contracts: pos.no_position,
        avgPrice: Math.round((pos.no_total_traded / pos.no_position) * 100),
      };
    }
    return null;
  } catch (e) {
    console.error(`[POSITION] Error checking NO position for ${ticker}:`, e);
    return null;
  }
}

async function executeSignal(signal: TradeSignal, confidenceScore: number = 70): Promise<void> {
  const { player, team, confidence, tweet } = signal;

  console.log(`\n[SIGNAL] ${confidence.name}: ${player}${team ? ` -> ${team}` : ""}`);
  console.log(`[SIGNAL] Source: @${tweet.author}`);

  // Get source reliability multiplier
  const sourceMultiplier = await getSourceReliability(tweet.author);

  // Find trade market to get current price
  const tradeMarket = findTradeMarket(player);
  const yesPrice = tradeMarket?.yes_price ? Math.round(tradeMarket.yes_price * 100) : 50;
  // IMPORTANT: Use correct price based on signal action (buy_yes vs buy_no)
  const currentPrice = confidence.action === "buy_yes" ? yesPrice : (100 - yesPrice);

  // Calculate dynamic position size
  const dynamicPct = calculateDynamicPositionSize(
    confidence.positionPct,
    confidenceScore,
    currentPrice,
    sourceMultiplier
  );
  const contracts = Math.round(BASE_CONTRACT_COUNT * dynamicPct);

  if (contracts === 0) {
    console.log(`[SIGNAL] Position size is 0 for ${confidence.name} tier, skipping`);
    return;
  }

  console.log(`[SIGNAL] Dynamic position: ${contracts} contracts (base would be ${Math.round(BASE_CONTRACT_COUNT * confidence.positionPct)})`);

  // Track prediction for accuracy scoring
  if (tradeMarket) {
    await trackPrediction(tweet.author, player, tradeMarket.ticker, confidence.name, tweet.id, team ?? undefined);
  }

  // Use dynamic max price from settings based on confidence tier
  const tierMaxPrice = getConfidenceTierMaxPrice(confidence.name);
  console.log(`[SIGNAL] Tier: ${confidence.name}, Max Price: ${tierMaxPrice}¢ (from settings)`);

  if (tradeMarket) {
    if (confidence.action === "buy_yes") {
      // POSITIVE signal - check if we have existing NO position to sell first (e.g., from deadline buying)
      const existingNoPos = await getExistingNoPosition(tradeMarket.ticker);
      if (existingNoPos && existingNoPos.contracts > 0) {
        console.log(`[SIGNAL] ⚠️ CONFLICT: Selling ${existingNoPos.contracts} existing NO contracts for ${player} (deadline position)`);
        await sendTelegramNotification(
          `⚠️ <b>EXITING NO POSITION</b>\n\n` +
          `Player: <b>${player}</b>\n` +
          `Reason: Trade signal received!\n` +
          `Selling: ${existingNoPos.contracts} NO contracts\n` +
          `Entry: ${existingNoPos.avgPrice}¢\n\n` +
          `Source: @${tweet.author}`
        );
        // Sell existing NO position at market (low limit to ensure fill)
        await placeOrder(tradeMarket.ticker, "no", "sell", existingNoPos.contracts, 5, signal);
      }
      await placeOrder(tradeMarket.ticker, "yes", "buy", contracts, tierMaxPrice, signal);
    } else if (confidence.action === "buy_no") {
      // NEGATIVE signal - check if we have existing YES position to sell first
      const existingPos = await getExistingPosition(tradeMarket.ticker);
      if (existingPos && existingPos.contracts > 0) {
        console.log(`[SIGNAL] NEGATIVE: Selling ${existingPos.contracts} existing YES contracts for ${player}`);
        // Sell existing YES position at market (low limit to ensure fill)
        await placeOrder(tradeMarket.ticker, "yes", "sell", existingPos.contracts, 5, signal);
      }
      // Also buy NO if we still want exposure
      await placeOrder(tradeMarket.ticker, "no", "buy", contracts, tierMaxPrice, signal);
    }
  } else {
    console.log(`[SIGNAL] No trade market found for: ${player}`);
  }

  // ENHANCED: Always try next team market when destination is mentioned (not just high confidence)
  if (team && confidence.action === "buy_yes") {
    const nextTeamMarket = findNextTeamMarket(player, team);
    if (nextTeamMarket) {
      console.log(`[SIGNAL] 🎯 NEXT TEAM: ${player} -> ${team}`);
      // Use same dynamic sizing for next team market
      const nextTeamPrice = nextTeamMarket.yes_price ? Math.round(nextTeamMarket.yes_price * 100) : 50;
      const nextTeamPct = calculateDynamicPositionSize(confidence.positionPct, confidenceScore, nextTeamPrice, sourceMultiplier);
      const nextTeamContracts = Math.round(BASE_CONTRACT_COUNT * nextTeamPct);

      await sendTelegramNotification(
        `🎯 <b>NEXT TEAM TRADE</b>\n\n` +
        `Player: <b>${player}</b>\n` +
        `Destination: <b>${team}</b>\n` +
        `Contracts: ${nextTeamContracts}\n` +
        `Price: ${nextTeamPrice}¢`
      );

      await placeOrder(nextTeamMarket.ticker, "yes", "buy", nextTeamContracts, tierMaxPrice, signal);
    } else {
      console.log(`[SIGNAL] No next team market for: ${player} -> ${team}`);
    }
  }
}

// =============================================================================
// TWITTER POLLING
// =============================================================================

const lastTweetIds: Record<string, string> = {};
const processedTweets = new Set<string>();

// Load persisted tweet IDs from database on startup
async function loadLastTweetIds(): Promise<void> {
  try {
    const { data } = await supabase
      .from("bot_status")
      .select("meta")
      .eq("id", "nba-trade-bot")
      .single();

    if (data?.meta?.lastTweetIds) {
      Object.assign(lastTweetIds, data.meta.lastTweetIds);
      console.log(`[TWITTER] Restored last tweet IDs for ${Object.keys(lastTweetIds).length} sources`);
    }
  } catch (e) {
    console.log("[TWITTER] No persisted tweet IDs found, starting fresh");
  }
}

// Save tweet IDs periodically
async function saveLastTweetIds(): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from("bot_status")
      .select("meta")
      .eq("id", "nba-trade-bot")
      .single();

    await supabase.from("bot_status").upsert({
      id: "nba-trade-bot",
      meta: {
        ...(existing?.meta || {}),
        lastTweetIds,
      },
    });
  } catch (e) {
    // Silently ignore save failures
  }
}

let twitterPollCount = 0;
let lastTwitterStatusLog = 0;
const TWITTER_STATUS_LOG_INTERVAL_MS = 300000; // Log status every 5 minutes

// Tiered polling - fastest for highest signal sources
const TIER1_POLL_MS = 5000;   // 5 seconds for Shams & Stein (breaking news)
const TIER2_POLL_MS = 30000;  // 30 seconds for major reporters
const TIER3_POLL_MS = 90000;  // 90 seconds for beat reporters & aggregators

// Track last poll time per source
const lastSourcePoll: Record<string, number> = {};

// Define which sources are in each polling tier
const TIER1_SOURCES = new Set([
  "ShamsCharania", "TheSteinLine"  // The big 2 - fastest (Woj retired)
]);
const TIER2_SOURCES = new Set([
  "WindhorstESPN", "ZachLowe_NBA", "ChrisBHaynes", "JakeLFischer",
  "ramonashelburne", "BobbyMarks42"  // Major national reporters
]);
// All others are Tier 3 (beat reporters, aggregators)

function getSourcePollInterval(handle: string): number {
  if (TIER1_SOURCES.has(handle)) return TIER1_POLL_MS;
  if (TIER2_SOURCES.has(handle)) return TIER2_POLL_MS;
  return TIER3_POLL_MS;
}

async function pollTwitter(): Promise<Tweet[]> {
  // Check feature toggle
  if (!botSettings.features.twitter_monitoring) {
    if (twitterPollCount === 0) {
      console.log("[TWITTER] ⚠️ Twitter monitoring is DISABLED in settings");
    }
    return [];
  }

  // Check if bearer token is configured
  if (!TWITTER_BEARER_TOKEN) {
    if (twitterPollCount === 0) {
      console.log("[TWITTER] ⚠️ TWITTER_BEARER_TOKEN not configured - Twitter monitoring disabled");
    }
    return [];
  }

  twitterPollCount++;
  const allTweets: Tweet[] = [];
  let successfulPolls = 0;
  let failedPolls = 0;
  let skippedPolls = 0;
  let tier1Polled = 0;
  let tier2Polled = 0;
  let tier3Polled = 0;
  const now = Date.now();

  for (const [handle, userId] of Object.entries(TRUSTED_SOURCES)) {
    // Check if this source is due for polling based on its tier
    const pollInterval = getSourcePollInterval(handle);
    const lastPoll = lastSourcePoll[handle] || 0;

    if (now - lastPoll < pollInterval) {
      skippedPolls++;
      continue; // Not time to poll this source yet
    }

    lastSourcePoll[handle] = now;
    try {
      const url = new URL(`https://api.twitter.com/2/users/${userId}/tweets`);
      url.searchParams.set("max_results", "5");
      url.searchParams.set("tweet.fields", "created_at,text,referenced_tweets");
      // Get full text of retweets and quoted tweets
      url.searchParams.set("expansions", "referenced_tweets.id");

      if (lastTweetIds[userId]) {
        url.searchParams.set("since_id", lastTweetIds[userId]);
      } else {
        // On first poll (no since_id), look back 1 hour to catch missed tweets
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        url.searchParams.set("start_time", oneHourAgo);
        url.searchParams.set("max_results", "20"); // Get more on first poll
      }

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
      });

      if (!response.ok) {
        failedPolls++;
        if (response.status === 429) {
          console.log(`[TWITTER] ⚠️ Rate limited on @${handle}`);
        } else if (response.status === 401) {
          console.log(`[TWITTER] ❌ Unauthorized (401) - check TWITTER_BEARER_TOKEN`);
        } else if (response.status === 403) {
          console.log(`[TWITTER] ❌ Forbidden (403) on @${handle} - API access issue`);
        } else {
          console.log(`[TWITTER] ❌ Error ${response.status} on @${handle}`);
        }
        continue;
      }

      successfulPolls++;

      const data = await response.json();

      if (data.meta?.newest_id) {
        lastTweetIds[userId] = data.meta.newest_id;
      }

      // Build a map of referenced tweet IDs to their full text
      const referencedTweets: Record<string, string> = {};
      for (const rt of data.includes?.tweets ?? []) {
        referencedTweets[rt.id] = rt.text;
      }

      for (const t of data.data ?? []) {
        if (!processedTweets.has(t.id)) {
          // For retweets, get the full text from the referenced tweet
          let fullText = t.text;
          if (t.referenced_tweets?.length > 0) {
            const rtRef = t.referenced_tweets.find((ref: { type: string }) => ref.type === "retweeted");
            if (rtRef && referencedTweets[rtRef.id]) {
              fullText = `RT: ${referencedTweets[rtRef.id]}`;
            }
            // For quote tweets, append the quoted text
            const qtRef = t.referenced_tweets.find((ref: { type: string }) => ref.type === "quoted");
            if (qtRef && referencedTweets[qtRef.id]) {
              fullText = `${t.text}\n\n[Quoted]: ${referencedTweets[qtRef.id]}`;
            }
          }

          allTweets.push({
            id: t.id,
            text: fullText,
            author: handle,
            created_at: t.created_at,
          });
        }
      }
    } catch (e) {
      failedPolls++;
      console.error(`[TWITTER] Exception for @${handle}:`, e);
    }
  }

  // Periodic status log (every 5 minutes)
  const statusNow = Date.now();
  if (statusNow - lastTwitterStatusLog > TWITTER_STATUS_LOG_INTERVAL_MS) {
    lastTwitterStatusLog = statusNow;
    const tier1Count = TIER1_SOURCES.size;
    const tier2Count = TIER2_SOURCES.size;
    const tier3Count = Object.keys(TRUSTED_SOURCES).length - tier1Count - tier2Count;
    console.log(`[TWITTER] Status: ${successfulPolls} polled, ${skippedPolls} skipped (not due), ${allTweets.length} new tweets`);
    console.log(`[TWITTER] Tiers: ${tier1Count} @5s, ${tier2Count} @30s, ${tier3Count} @90s`);
    // Persist tweet IDs for continuity across restarts
    await saveLastTweetIds();
  }

  return allTweets;
}

// =============================================================================
// MAIN LOOP
// =============================================================================

async function processTweet(tweet: Tweet): Promise<void> {
  // Check in-memory cache first
  if (processedTweets.has(tweet.id)) return;

  // Check database for persistence across restarts
  const { data: existing } = await supabase
    .from("tweets")
    .select("id")
    .eq("tweet_id", tweet.id)
    .single();

  if (existing) {
    processedTweets.add(tweet.id); // Add to memory cache
    return; // Already processed
  }

  processedTweets.add(tweet.id);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[TWEET] @${tweet.author}: ${tweet.text.substring(0, 120)}...`);

  // Use LLM for semantic analysis (falls back to keyword matching if unavailable)
  const { signals, analysisId } = await extractSignalsWithLLM(tweet);
  const playersMentioned = signals.map(s => s.player);
  const confidence = signals.length > 0 ? signals[0].confidence.name : null;

  // Store tweet in database (marks as processed)
  try {
    await supabase.from("tweets").upsert({
      tweet_id: tweet.id,
      author_handle: tweet.author,
      author_id: TRUSTED_SOURCES[tweet.author] ?? "",
      text: tweet.text,
      created_at: tweet.created_at,
      players_mentioned: playersMentioned,
      confidence_tier: confidence,
      meta: { signals_count: signals.length, processed: true },
    }, { onConflict: "tweet_id" });
  } catch (e) {
    console.error("[TWEET] Error storing tweet:", e);
  }

  if (signals.length === 0) {
    console.log(`[TWEET] No actionable signals`);
    return;
  }

  for (const signal of signals) {
    await executeSignal(signal, signal.confidence_score);
  }
}

async function runBot(): Promise<void> {
  console.log("═".repeat(60));
  console.log(" NBA TRADE DEADLINE BOT v2 - ADVANCED TRADING");
  console.log("═".repeat(60));
  console.log(`Monitoring: ${Object.keys(TRUSTED_SOURCES).join(", ")}`);
  console.log(`Base position: ${BASE_CONTRACT_COUNT} contracts`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log("");
  console.log("Confidence Tiers:");
  for (const [key, tier] of Object.entries(CONFIDENCE_TIERS)) {
    console.log(`  ${tier.name.padEnd(12)} ${(tier.positionPct * 100).toString().padStart(3)}% position, max ${tier.maxPrice}c, action: ${tier.action}`);
  }
  console.log("═".repeat(60));

  // Initial load
  await refreshMarketCache();

  // Load persisted tweet IDs for continuity across restarts
  await loadLastTweetIds();

  // Check Twitter configuration
  if (!TWITTER_BEARER_TOKEN) {
    console.log("\n⚠️  WARNING: TWITTER_BEARER_TOKEN not set - Twitter monitoring DISABLED");
    console.log("   Set this in .env.local to enable breaking news detection\n");
  } else if (!botSettings.features.twitter_monitoring) {
    console.log("\n⚠️  WARNING: twitter_monitoring feature is disabled in settings\n");
  } else {
    console.log(`\n✅ Twitter monitoring ENABLED - polling ${Object.keys(TRUSTED_SOURCES).length} sources`);
  }

  console.log("\n[BOT] Starting real-time monitoring...\n");

  // Track intervals for different checks
  let lastProfitTakeCheck = 0;
  let lastOrderbookCheck = 0;
  let lastFlightCheck = 0;
  let lastDailySummary = 0;
  let lastPriceHistoryRecord = 0;
  const PROFIT_TAKE_INTERVAL_MS = 60000;  // Every 60 seconds
  const ORDERBOOK_CHECK_INTERVAL_MS = 30000; // Every 30 seconds
  const FLIGHT_CHECK_INTERVAL_MS = 900000; // Every 15 minutes
  const DAILY_SUMMARY_INTERVAL_MS = 3600000; // Every hour (sends summary)
  const PRICE_HISTORY_INTERVAL_MS = 30000; // Every 30 seconds

  // Load settings from Supabase at startup
  await loadSettings(true);

  // Subscribe to realtime settings changes for instant updates
  subscribeToSettingsChanges();

  // Send startup notification with settings info
  await sendTelegramNotification(
    `🚀 <b>NBA TRADE BOT STARTED</b>\n\n` +
    `Monitoring ${Object.keys(TRUSTED_SOURCES).length} sources\n` +
    `${tradeMarkets.length} trade markets loaded\n` +
    `Poll interval: ${POLL_INTERVAL_MS / 1000}s\n\n` +
    `<b>Settings:</b>\n` +
    `• Base contracts: ${botSettings.base_contract_count}\n` +
    `• Max prices: ${botSettings.max_price_confirmed}/${botSettings.max_price_imminent}/${botSettings.max_price_serious}¢\n` +
    `• Spike trading: ${botSettings.features.price_spike_trading ? "ON" : "OFF"}\n` +
    `• Spike max entry: ${botSettings.price_spike_max_entry}¢`
  );

  while (true) {
    try {
      // Refresh settings from Supabase (has 60s cache)
      await loadSettings();

      await refreshMarketCache();

      const now = Date.now();

      // Profit-taking: Check if any positions are at 95%+ and sell
      if (now - lastProfitTakeCheck > PROFIT_TAKE_INTERVAL_MS) {
        lastProfitTakeCheck = now;
        await checkProfitTaking();
      }

      // Deadline countdown: Auto-buy NOs on players unlikely to be traded
      await checkDeadlineNoBuying();

      // Price movement detection (runs every cycle)
      await checkPriceMovements();

      // Orderbook depth monitoring (every 30s to save API calls)
      if (now - lastOrderbookCheck > ORDERBOOK_CHECK_INTERVAL_MS) {
        lastOrderbookCheck = now;
        await monitorAllOrderbooks();
      }

      // Flight tracking (every 15 minutes)
      if (now - lastFlightCheck > FLIGHT_CHECK_INTERVAL_MS) {
        lastFlightCheck = now;
        await checkFlightActivity();
      }

      // Hourly summary
      if (now - lastDailySummary > DAILY_SUMMARY_INTERVAL_MS) {
        lastDailySummary = now;
        await sendDailySummary();
      }

      // Record price history for charts (every 30 seconds)
      if (now - lastPriceHistoryRecord > PRICE_HISTORY_INTERVAL_MS) {
        lastPriceHistoryRecord = now;
        await recordPriceHistory();
      }

      // Twitter polling
      const tweets = await pollTwitter();

      // Update bot status in database with current settings
      const { error: statusError } = await supabase.from("bot_status").upsert({
        id: "nba-trade-bot",
        last_poll_at: new Date().toISOString(),
        status: "running",
        meta: {
          tweets_in_batch: tweets.length,
          markets_loaded: tradeMarkets.length,
          poll_interval_ms: POLL_INTERVAL_MS,
          sources_monitored: Object.keys(TRUSTED_SOURCES).length,
          settings: {
            base_contract_count: botSettings.base_contract_count,
            max_price_confirmed: botSettings.max_price_confirmed,
            max_price_imminent: botSettings.max_price_imminent,
            max_price_serious: botSettings.max_price_serious,
            price_spike_trading: botSettings.features.price_spike_trading,
            price_spike_max_entry: botSettings.price_spike_max_entry,
          },
        },
      });
      if (statusError) {
        console.error("[BOT] Failed to update status:", statusError);
      }

      if (tweets.length > 0) {
        console.log(`[TWITTER] Found ${tweets.length} new tweets`);
        for (const tweet of tweets) {
          await processTweet(tweet);
        }
      }
    } catch (e) {
      console.error("[BOT] Error in main loop:", e);
    }

    // Run loop at fastest tier interval (5s) - tiered polling handles source frequency
    await new Promise((resolve) => setTimeout(resolve, TIER1_POLL_MS));
  }
}

runBot().catch(console.error);
