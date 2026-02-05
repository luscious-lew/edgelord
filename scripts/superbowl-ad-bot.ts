// =============================================================================
// SUPER BOWL AD BOT - Monitor & Trade Super Bowl Advertisement Markets
// =============================================================================
// Key Rules:
// - Market resolves YES if SPECIFIC brand listed runs ad during game
// - Must be after kick-off, before game ends (no pre-game/post-game)
// - Parent company ads without specific brand mention = NO
// - Example: If market is "Anthropic" and only "Claude" appears = NO
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

// Super Bowl 2026 is February 9, 2026
const SUPER_BOWL_DATE = new Date("2026-02-09T18:30:00-05:00"); // 6:30 PM ET kickoff
const SUPER_BOWL_END_APPROX = new Date("2026-02-09T22:30:00-05:00"); // ~10:30 PM ET

const BASE_CONTRACT_COUNT = 50; // Conservative base position
const POLL_INTERVAL_MS = 5000; // 5 seconds during game, can be longer pre-game

// =============================================================================
// MARKET DATA TYPES
// =============================================================================

type AdMarket = {
  ticker: string;
  brand_name: string;
  yes_price: number;
  no_price: number;
  volume: number;
  open_interest: number;
};

type Tweet = {
  id: string;
  text: string;
  author: string;
  created_at: string;
};

type AdSignal = {
  brand: string;
  confidence: "confirmed" | "likely" | "rumor";
  source: string;
  tweet: Tweet;
};

// =============================================================================
// TWITTER SOURCES FOR AD MONITORING
// =============================================================================

// Combined sources for Super Bowl ad monitoring
const TRUSTED_SOURCES: Record<string, string> = {
  // ═══════════════════════════════════════════════════════════════════
  // TIER 1 - Ad industry primary sources (5 second polling during game)
  // ═══════════════════════════════════════════════════════════════════
  "AdAge": "12480582",        // Ad Age - top ad industry news
  "AdWeek": "30205586",       // Adweek - advertising news
  "SBCommercials": "19797772", // Super Bowl Commercials account

  // ═══════════════════════════════════════════════════════════════════
  // TIER 2 - Entertainment & business news (30 second polling)
  // ═══════════════════════════════════════════════════════════════════
  "Variety": "17525171",      // Variety - entertainment industry
  "THR": "17446621",          // Hollywood Reporter
  "WSJ": "3108351",           // Wall Street Journal
  "CNBC": "20402945",         // CNBC business news
  "business": "34713362",     // Bloomberg Business

  // ═══════════════════════════════════════════════════════════════════
  // TIER 3 - Marketing trade publications (90 second polling)
  // ═══════════════════════════════════════════════════════════════════
  "digiday": "20640328",      // Digital advertising news
  "marketingweek": "15277515", // Marketing Week
  "SBAdvertising": "41457393", // Super Bowl Advertising

  // ═══════════════════════════════════════════════════════════════════
  // BRAND ACCOUNTS - Monitor for self-announcements
  // ═══════════════════════════════════════════════════════════════════
  "OpenAI": "4398626122",
  "AnthropicAI": "1353836358901501952",
  "Perplexity_AI": "1599587232175849472",
  "xAI": "1661523610111193088",
  "nvidia": "61559439",
  "coinbase": "574032254",
  "pepsi": "18139619",
  "TMobile": "17338082",
  "LiquidDeath": "921836597569503233",
  "DoorDash": "1531669496",
  "netflix": "16573941",
  "temu_official": "1466425730045296649",
  "allstate": "14275290",
};

// Tiered polling intervals
const TIER1_POLL_MS = 5000;   // 5 seconds for ad industry during game
const TIER2_POLL_MS = 30000;  // 30 seconds for news sources
const TIER3_POLL_MS = 60000;  // 60 seconds for brand accounts (pre-game)

const TIER1_SOURCES = new Set(["AdAge", "AdWeek", "SBCommercials"]);
const TIER2_SOURCES = new Set(["Variety", "THR", "WSJ", "CNBC", "business"]);
// All others are Tier 3

function getSourcePollInterval(handle: string): number {
  if (TIER1_SOURCES.has(handle)) return TIER1_POLL_MS;
  if (TIER2_SOURCES.has(handle)) return TIER2_POLL_MS;
  return TIER3_POLL_MS;
}

const lastSourcePoll: Record<string, number> = {};

// =============================================================================
// BRAND MATCHING - Critical for correct resolution
// =============================================================================

// =============================================================================
// BLOCKED BRANDS - DO NOT TRADE
// User has confirmed these ads do NOT show the required brand name
// =============================================================================
const BLOCKED_BRANDS = new Set([
  "ANTHROPIC", // Ad only shows "Claude", not "Anthropic" - will resolve NO
]);

// Map of market tickers to exact brand names that qualify
// IMPORTANT: Only these exact brand names resolve YES
const BRAND_MATCHES: Record<string, {
  ticker: string;
  exactNames: string[];  // Must match one of these EXACTLY
  parentCompany?: string; // Parent company does NOT qualify
  relatedBrands?: string[]; // Related brands that do NOT qualify
}> = {
  // ANTHROPIC - BLOCKED: Ad only shows "Claude" not "Anthropic" - resolves NO
  // "ANTHROPIC": {
  //   ticker: "KXSUPERBOWLAD-SB2026-ANTHROPIC",
  //   exactNames: ["Anthropic"],
  //   relatedBrands: ["Claude", "Claude AI"],
  // },
  "OPENAI": {
    ticker: "KXSUPERBOWLAD-SB2026-OPENAI",
    exactNames: ["OpenAI"],
    relatedBrands: ["ChatGPT", "GPT-4", "DALL-E", "Sora"], // These do NOT qualify!
  },
  "GEMINI": {
    ticker: "KXSUPERBOWLAD-SB2026-GEMI",
    exactNames: ["Gemini", "Google Gemini"],
    parentCompany: "Google",
    relatedBrands: ["Bard"], // Old name, doesn't qualify
  },
  "PERPLEXITY": {
    ticker: "KXSUPERBOWLAD-SB2026-PERP",
    exactNames: ["Perplexity", "Perplexity AI"],
  },
  "GROK": {
    ticker: "KXSUPERBOWLAD-SB2026-GROK",
    exactNames: ["Grok", "xAI Grok"],
    parentCompany: "xAI",
  },
  "NVIDIA": {
    ticker: "KXSUPERBOWLAD-SB2026-NVIDIA",
    exactNames: ["NVIDIA", "Nvidia"],
    relatedBrands: ["GeForce", "RTX", "CUDA"], // Product lines
  },
  "COINBASE": {
    ticker: "KXSUPERBOWLAD-SB2026-COIN",
    exactNames: ["Coinbase"],
  },
  "PEPSI": {
    ticker: "KXSUPERBOWLAD-SB2026-PEPSI",
    exactNames: ["Pepsi", "Pepsi-Cola"],
    parentCompany: "PepsiCo",
    relatedBrands: ["Lay's", "Doritos", "Mountain Dew", "Gatorade"], // PepsiCo brands
  },
  "TMOBILE": {
    ticker: "KXSUPERBOWLAD-SB2026-TMOBILE",
    exactNames: ["T-Mobile", "TMobile"],
  },
  "LIQUID_DEATH": {
    ticker: "KXSUPERBOWLAD-SB2026-LIQU",
    exactNames: ["Liquid Death"],
  },
  "AMAZON_PRIME": {
    ticker: "KXSUPERBOWLAD-SB2026-AMAZ",
    exactNames: ["Amazon Prime", "Prime Video"],
    parentCompany: "Amazon",
    relatedBrands: ["AWS", "Alexa", "Ring", "Whole Foods"], // Amazon subsidiaries
  },
  "HIMS": {
    ticker: "KXSUPERBOWLAD-SB2026-HIMS",
    exactNames: ["Hims", "Hers", "Hims & Hers"],
  },
  "NETFLIX": {
    ticker: "KXSUPERBOWLAD-SB2026-NETF",
    exactNames: ["Netflix"],
  },
  "TEMU": {
    ticker: "KXSUPERBOWLAD-SB2026-TEMU",
    exactNames: ["Temu"],
    parentCompany: "PDD Holdings",
  },
  "ALLSTATE": {
    ticker: "KXSUPERBOWLAD-SB2026-ALLS",
    exactNames: ["Allstate"],
  },
  "DISNEY_PLUS": {
    ticker: "KXSUPERBOWLAD-SB2026-DISN",
    exactNames: ["Disney+", "Disney Plus"],
    parentCompany: "Disney",
    relatedBrands: ["Hulu", "ESPN+", "Marvel", "Pixar"], // Disney properties
  },
  "PARAMOUNT_PLUS": {
    ticker: "KXSUPERBOWLAD-SB2026-PARA",
    exactNames: ["Paramount+", "Paramount Plus"],
    parentCompany: "Paramount Global",
  },
  "NIKE": {
    ticker: "KXSUPERBOWLAD-SB2026-NIKE",
    exactNames: ["Nike"],
    relatedBrands: ["Jordan", "Air Jordan", "Converse"], // Nike subsidiaries
  },
  "DOORDASH": {
    ticker: "KXSUPERBOWLAD-SB2026-DOOR",
    exactNames: ["DoorDash"],
  },
  "JEEP": {
    ticker: "KXSUPERBOWLAD-SB2026-JEEP",
    exactNames: ["Jeep"],
    parentCompany: "Stellantis",
    relatedBrands: ["Dodge", "Ram", "Chrysler"], // Stellantis brands
  },
  "TESLA": {
    ticker: "KXSUPERBOWLAD-SB2026-TESL",
    exactNames: ["Tesla"],
    relatedBrands: ["SpaceX", "X", "xAI"], // Musk companies
  },
  "YEEZY": {
    ticker: "KXSUPERBOWLAD-SB2026-YEEZ",
    exactNames: ["Yeezy"],
  },
  "SPOTIFY": {
    ticker: "KXSUPERBOWLAD-SB2026-SPOT",
    exactNames: ["Spotify"],
  },
  "VUORI": {
    ticker: "KXSUPERBOWLAD-SB2026-VUOR",
    exactNames: ["Vuori"],
  },
  "ZYN": {
    ticker: "KXSUPERBOWLAD-SB2026-ZYN",
    exactNames: ["Zyn", "ZYN"],
    parentCompany: "Philip Morris",
  },
  "SHEIN": {
    ticker: "KXSUPERBOWLAD-SB2026-SHEI",
    exactNames: ["SHEIN", "Shein"],
  },
  "BLUECHEW": {
    ticker: "KXSUPERBOWLAD-SB2026-BLUE",
    exactNames: ["BlueChew"],
  },
  "ATHLETIC_GREENS": {
    ticker: "KXSUPERBOWLAD-SB2026-ATHL",
    exactNames: ["Athletic Greens", "AG1"],
  },
};

// =============================================================================
// KALSHI API HELPERS
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

let adMarkets: AdMarket[] = [];
let lastMarketRefresh = 0;
const MARKET_REFRESH_MS = 30000;

async function refreshMarketCache(): Promise<void> {
  const now = Date.now();
  if (now - lastMarketRefresh < MARKET_REFRESH_MS) return;

  try {
    console.log("[CACHE] Refreshing Super Bowl ad markets...");
    const resp = await fetch("https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXSUPERBOWLAD&limit=200");
    const data = await resp.json();

    adMarkets = (data.markets || []).map((m: any) => {
      // Extract brand name from title "Will X run an ad..."
      const brandMatch = m.title?.match(/Will\s+(.+?)\s+run an ad/i);
      return {
        ticker: m.ticker,
        brand_name: brandMatch ? brandMatch[1] : m.yes_sub_title || m.ticker,
        yes_price: (m.yes_bid ?? 50) / 100,
        no_price: (m.no_bid ?? 50) / 100,
        volume: m.volume ?? 0,
        open_interest: m.open_interest ?? 0,
      };
    });

    lastMarketRefresh = now;
    console.log(`[CACHE] Loaded ${adMarkets.length} Super Bowl ad markets`);
  } catch (e) {
    console.error("[CACHE] Error refreshing markets:", e);
  }
}

// =============================================================================
// TELEGRAM NOTIFICATIONS
// =============================================================================

async function sendTelegramNotification(message: string, retries = 3): Promise<void> {
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
        console.error(`[TELEGRAM] Failed after ${retries} attempts`);
      }
    }
  }
}

// =============================================================================
// LLM ANALYSIS FOR AD DETECTION
// =============================================================================

async function analyzeAdTweet(tweet: Tweet): Promise<AdSignal[]> {
  if (!GROQ_API_KEY) {
    return analyzeAdTweetFallback(tweet);
  }

  const brandList = Object.entries(BRAND_MATCHES)
    .map(([key, info]) => `${key}: matches [${info.exactNames.join(", ")}]${info.relatedBrands ? `, NOT [${info.relatedBrands.join(", ")}]` : ""}`)
    .join("\n");

  const prompt = `Analyze this tweet about Super Bowl ads. Identify any brands that are CONFIRMED to be advertising.

CRITICAL RULES:
1. Only the EXACT brand name listed qualifies (not parent company or related products)
2. "Anthropic" ad = YES for Anthropic market, but "Claude" ad = NO for Anthropic market
3. "OpenAI" ad = YES for OpenAI market, but "ChatGPT" ad = NO for OpenAI market
4. Return only brands with CONFIRMED ads (not rumors unless explicitly stated)

Brand list:
${brandList}

Tweet from @${tweet.author}:
"${tweet.text}"

Return JSON array of confirmed ads:
[{"brand": "BRAND_KEY", "confidence": "confirmed|likely|rumor", "exact_brand_shown": "brand name seen"}]

If no confirmed ads, return: []`;

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
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      console.log(`[GROQ] API error: ${response.status}`);
      return analyzeAdTweetFallback(tweet);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "[]";

    // Extract JSON from response
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const signals = JSON.parse(jsonMatch[0]);
    return signals.map((s: any) => ({
      brand: s.brand,
      confidence: s.confidence,
      source: tweet.author,
      tweet,
    }));
  } catch (e) {
    console.error("[GROQ] Analysis error:", e);
    return analyzeAdTweetFallback(tweet);
  }
}

function analyzeAdTweetFallback(tweet: Tweet): AdSignal[] {
  const signals: AdSignal[] = [];
  const text = tweet.text.toLowerCase();

  // Check for each brand
  for (const [brandKey, brandInfo] of Object.entries(BRAND_MATCHES)) {
    // Check if any exact name matches
    for (const exactName of brandInfo.exactNames) {
      if (text.includes(exactName.toLowerCase())) {
        // Check it's not just the related brand
        let isRelatedBrandOnly = false;
        if (brandInfo.relatedBrands) {
          for (const related of brandInfo.relatedBrands) {
            if (text.includes(related.toLowerCase()) && !text.includes(exactName.toLowerCase())) {
              isRelatedBrandOnly = true;
              break;
            }
          }
        }

        if (!isRelatedBrandOnly) {
          // Look for confirmation keywords
          const isConfirmed = /confirm|official|will air|airing|bought|purchased|secured|running/i.test(tweet.text);
          const isLikely = /likely|expected|planning|set to|will run/i.test(tweet.text);
          const isRumor = /rumor|might|could|considering|may/i.test(tweet.text);

          signals.push({
            brand: brandKey,
            confidence: isConfirmed ? "confirmed" : isLikely ? "likely" : "rumor",
            source: tweet.author,
            tweet,
          });
          break; // Only one signal per brand
        }
      }
    }
  }

  return signals;
}

// =============================================================================
// TWITTER POLLING
// =============================================================================

const lastTweetIds: Record<string, string> = {};
const processedTweets = new Set<string>();

async function pollTwitter(): Promise<Tweet[]> {
  if (!TWITTER_BEARER_TOKEN) {
    console.log("[TWITTER] No bearer token configured");
    return [];
  }

  const allTweets: Tweet[] = [];
  const now = Date.now();
  let polled = 0;
  let skipped = 0;

  for (const [handle, userId] of Object.entries(TRUSTED_SOURCES)) {
    // Check if this source is due for polling based on its tier
    const pollInterval = getSourcePollInterval(handle);
    const lastPoll = lastSourcePoll[handle] || 0;

    if (now - lastPoll < pollInterval) {
      skipped++;
      continue; // Not time to poll this source yet
    }

    lastSourcePoll[handle] = now;
    polled++;

    try {
      const url = new URL(`https://api.twitter.com/2/users/${userId}/tweets`);
      url.searchParams.set("max_results", "5");
      url.searchParams.set("tweet.fields", "created_at,text");

      if (lastTweetIds[userId]) {
        url.searchParams.set("since_id", lastTweetIds[userId]);
      } else {
        // Look back 2 hours on first poll
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        url.searchParams.set("start_time", twoHoursAgo);
      }

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.log(`[TWITTER] Rate limited on @${handle}`);
        }
        continue;
      }

      const data = await response.json();

      if (data.meta?.newest_id) {
        lastTweetIds[userId] = data.meta.newest_id;
      }

      if (data.data) {
        for (const tweet of data.data) {
          if (!processedTweets.has(tweet.id)) {
            allTweets.push({
              id: tweet.id,
              text: tweet.text,
              author: handle,
              created_at: tweet.created_at,
            });
          }
        }
      }
    } catch (e) {
      console.error(`[TWITTER] Error polling @${handle}:`, e);
    }
  }

  if (polled > 0) {
    console.log(`[TWITTER] Polled ${polled} sources, skipped ${skipped} (not due), found ${allTweets.length} tweets`);
  }

  return allTweets;
}

// =============================================================================
// ORDER PLACEMENT
// =============================================================================

async function placeOrder(
  ticker: string,
  side: "yes" | "no",
  action: "buy" | "sell",
  count: number,
  maxPrice: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const market = adMarkets.find(m => m.ticker === ticker);
    const currentPrice = market ? Math.round(market.yes_price * 100) : 50;

    // Don't buy if already priced in
    if (action === "buy" && currentPrice >= 98) {
      console.log(`[ORDER] SKIP: ${ticker} already at ${currentPrice}¢ - priced in`);
      return { success: false, error: "Market already priced in" };
    }

    // Don't buy above max price
    if (action === "buy" && currentPrice > maxPrice) {
      console.log(`[ORDER] SKIP: ${ticker} at ${currentPrice}¢ > max ${maxPrice}¢`);
      return { success: false, error: `Price ${currentPrice}¢ > max ${maxPrice}¢` };
    }

    const orderPath = "/trade-api/v2/portfolio/orders";
    const headers = await getKalshiHeaders("POST", orderPath);

    const orderBody = {
      ticker,
      client_order_id: `sbad-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      type: "market",
      action,
      side,
      count,
    };

    const response = await fetch(`https://api.elections.kalshi.com${orderPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(orderBody),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[ORDER] Failed: ${error}`);
      return { success: false, error };
    }

    const result = await response.json();
    console.log(`[ORDER] ${action.toUpperCase()} ${count} ${side.toUpperCase()} on ${ticker} - ${result.order?.status}`);

    return { success: true };
  } catch (e) {
    console.error("[ORDER] Error:", e);
    return { success: false, error: String(e) };
  }
}

// =============================================================================
// SIGNAL EXECUTION
// =============================================================================

async function executeAdSignal(signal: AdSignal): Promise<void> {
  // Check if brand is blocked (user confirmed ad doesn't qualify)
  if (BLOCKED_BRANDS.has(signal.brand)) {
    console.log(`[SIGNAL] BLOCKED: ${signal.brand} - ad does not show required brand name (resolves NO)`);
    return;
  }

  const brandInfo = BRAND_MATCHES[signal.brand];
  if (!brandInfo) {
    console.log(`[SIGNAL] Unknown brand: ${signal.brand}`);
    return;
  }

  const market = adMarkets.find(m => m.ticker === brandInfo.ticker);
  if (!market) {
    console.log(`[SIGNAL] No market found for ${signal.brand}`);
    return;
  }

  const currentPrice = Math.round(market.yes_price * 100);

  // Confidence-based sizing and max price
  let positionPct = 0;
  let maxPrice = 0;

  switch (signal.confidence) {
    case "confirmed":
      positionPct = 1.0; // 100% of base
      maxPrice = 99;
      break;
    case "likely":
      positionPct = 0.5; // 50% of base
      maxPrice = 90;
      break;
    case "rumor":
      positionPct = 0; // Don't trade on rumors
      maxPrice = 0;
      break;
  }

  if (positionPct === 0) {
    console.log(`[SIGNAL] ${signal.brand}: ${signal.confidence} - no trade (rumor only)`);
    return;
  }

  const contracts = Math.round(BASE_CONTRACT_COUNT * positionPct);

  console.log(`\n[SIGNAL] ${signal.confidence.toUpperCase()}: ${signal.brand} ad detected!`);
  console.log(`[SIGNAL] Source: @${signal.source}`);
  console.log(`[SIGNAL] Market: ${market.ticker} at ${currentPrice}¢`);
  console.log(`[SIGNAL] Action: BUY ${contracts} YES (max ${maxPrice}¢)`);

  await sendTelegramNotification(
    `📺 <b>SUPER BOWL AD DETECTED</b>\n\n` +
    `Brand: <b>${signal.brand}</b>\n` +
    `Confidence: ${signal.confidence.toUpperCase()}\n` +
    `Source: @${signal.source}\n` +
    `Price: ${currentPrice}¢\n` +
    `Action: BUY ${contracts} YES\n\n` +
    `"${signal.tweet.text.substring(0, 150)}..."`
  );

  await placeOrder(brandInfo.ticker, "yes", "buy", contracts, maxPrice);
}

// =============================================================================
// PROCESS TWEETS
// =============================================================================

async function processTweet(tweet: Tweet): Promise<void> {
  if (processedTweets.has(tweet.id)) return;
  processedTweets.add(tweet.id);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[TWEET] @${tweet.author}: ${tweet.text.substring(0, 120)}...`);

  // Store tweet in database for the web UI feed
  try {
    await supabase.from("tweets").upsert({
      tweet_id: tweet.id,
      author_handle: tweet.author,
      author_id: TRUSTED_SOURCES[tweet.author] ?? "",
      text: tweet.text,
      created_at: tweet.created_at,
      fetched_at: new Date().toISOString(),
      players_mentioned: [], // Not applicable for ads
      confidence_tier: null,
      meta: { source: "superbowl-ad-bot" },
    }, { onConflict: "tweet_id" });
  } catch (e) {
    console.error("[TWEET] Error storing tweet:", e);
  }

  const signals = await analyzeAdTweet(tweet);

  if (signals.length === 0) {
    console.log(`[TWEET] No ad signals detected`);
    return;
  }

  for (const signal of signals) {
    await executeAdSignal(signal);
  }
}

// =============================================================================
// MARKET DISPLAY
// =============================================================================

function displayMarkets(): void {
  console.log("\n" + "═".repeat(70));
  console.log(" SUPER BOWL AD MARKETS - Current Prices");
  console.log("═".repeat(70));

  // Sort by price (highest first)
  const sorted = [...adMarkets].sort((a, b) => b.yes_price - a.yes_price);

  for (const market of sorted.slice(0, 20)) {
    const pricePct = Math.round(market.yes_price * 100);
    const bar = "█".repeat(Math.floor(pricePct / 5)) + "░".repeat(20 - Math.floor(pricePct / 5));
    console.log(`${market.brand_name.padEnd(20)} ${bar} ${pricePct.toString().padStart(2)}¢  (vol: ${market.volume.toLocaleString()})`);
  }

  console.log("═".repeat(70));
}

// =============================================================================
// MAIN BOT LOOP
// =============================================================================

async function runBot(): Promise<void> {
  console.log("═".repeat(70));
  console.log(" SUPER BOWL AD BOT - Monitoring Advertisement Markets");
  console.log("═".repeat(70));

  const now = new Date();
  const hoursUntilGame = (SUPER_BOWL_DATE.getTime() - now.getTime()) / (1000 * 60 * 60);
  const isDuringGame = now >= SUPER_BOWL_DATE && now <= SUPER_BOWL_END_APPROX;

  console.log(`Super Bowl: ${SUPER_BOWL_DATE.toLocaleString()}`);
  console.log(`Current time: ${now.toLocaleString()}`);
  console.log(`Hours until kickoff: ${hoursUntilGame.toFixed(1)}`);
  console.log(`Mode: ${isDuringGame ? "LIVE GAME" : "PRE-GAME MONITORING"}`);
  console.log("");

  // Initial market load
  await refreshMarketCache();
  displayMarkets();

  // Check Twitter config
  if (!TWITTER_BEARER_TOKEN) {
    console.log("\n⚠️  WARNING: TWITTER_BEARER_TOKEN not set - Twitter monitoring DISABLED\n");
  } else {
    console.log(`\n✅ Twitter monitoring ENABLED - ${Object.keys(TRUSTED_SOURCES).length} sources`);
  }

  // Startup notification
  await sendTelegramNotification(
    `📺 <b>SUPER BOWL AD BOT STARTED</b>\n\n` +
    `Monitoring ${adMarkets.length} ad markets\n` +
    `Hours until kickoff: ${hoursUntilGame.toFixed(1)}\n` +
    `Mode: ${isDuringGame ? "LIVE GAME" : "PRE-GAME"}\n` +
    `Base position: ${BASE_CONTRACT_COUNT} contracts`
  );

  console.log("\n[BOT] Starting monitoring loop...\n");

  let lastDisplayTime = 0;
  const DISPLAY_INTERVAL_MS = 300000; // 5 minutes

  while (true) {
    try {
      await refreshMarketCache();

      // Poll Twitter for ad news
      const tweets = await pollTwitter();

      if (tweets.length > 0) {
        console.log(`[TWITTER] Found ${tweets.length} new tweets`);
        for (const tweet of tweets) {
          await processTweet(tweet);
        }
      }

      // Periodic market display
      const now = Date.now();
      if (now - lastDisplayTime > DISPLAY_INTERVAL_MS) {
        displayMarkets();
        lastDisplayTime = now;
      }
    } catch (e) {
      console.error("[BOT] Error in main loop:", e);
    }

    // Faster polling during game, slower pre-game
    const currentTime = new Date();
    const isDuringGameNow = currentTime >= SUPER_BOWL_DATE && currentTime <= SUPER_BOWL_END_APPROX;
    const pollInterval = isDuringGameNow ? 5000 : 30000;

    await new Promise(r => setTimeout(r, pollInterval));
  }
}

// Start the bot
runBot().catch(console.error);
