import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { supabase } from "../_shared/supabaseClient.ts";
import { getKalshiAuthHeaders } from "../_shared/kalshiAuth.ts";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2/markets";

type KalshiMarket = {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  title: string;
  category?: string;
  status: string;
  yes_price?: number;
  no_price?: number;
  yes_bid?: number;
  no_bid?: number;
  yes_ask?: number;
  no_ask?: number;
  last_price?: number;
  volume?: number;
  open_interest?: number;
  [key: string]: any; // Allow other fields
};

type MarketsResponse = {
  markets?: KalshiMarket[];
  next_cursor?: string | null;
};

async function fetchAllOpenMarkets(): Promise<KalshiMarket[]> {
  let allMarkets: KalshiMarket[] = [];
  let nextCursor: string | null | undefined = "";
  const safetyLimit = 10; // Avoid infinite loops
  let requests = 0;

  while (nextCursor !== null && requests < safetyLimit) {
    const queryParams = `?status=open${nextCursor ? `&cursor=${nextCursor}` : ''}`;
    const url = `${KALSHI_BASE}${queryParams}`;
    const path = `/trade-api/v2/markets${queryParams}`;
    const headers = await getKalshiAuthHeaders("GET", path);
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch markets: ${response.statusText}`);
    }

    const responseData = await response.json();
    const { markets, next_cursor }: MarketsResponse = responseData;
    
    // Log first market to debug field names
    if (markets && markets.length > 0 && requests === 0) {
      console.log("Sample market from Kalshi API:", JSON.stringify(markets[0], null, 2));
    }
    
    if (markets) {
      allMarkets = allMarkets.concat(markets);
    }
    nextCursor = next_cursor;
    requests++;
  }

  return allMarkets;
}

async function upsertMarkets(markets: KalshiMarket[]): Promise<number> {
  // Deduplicate markets by ticker to avoid "cannot affect row a second time" error
  const uniqueMarkets = new Map<string, KalshiMarket>();
  for (const market of markets) {
    if (!uniqueMarkets.has(market.ticker)) {
      uniqueMarkets.set(market.ticker, market);
    }
  }

  const rows = Array.from(uniqueMarkets.values()).map((m) => {
    // Kalshi prices might be in cents (0-100) or as decimals (0-1)
    // Try multiple field names and normalize to 0-1 range
    let yesPrice = m.yes_price ?? m.yes_bid ?? m.yes_ask ?? null;
    let noPrice = m.no_price ?? m.no_bid ?? m.no_ask ?? null;
    
    // If prices are in cents (0-100), convert to decimal (0-1)
    if (yesPrice !== null && yesPrice > 1) {
      yesPrice = yesPrice / 100;
    }
    if (noPrice !== null && noPrice > 1) {
      noPrice = noPrice / 100;
    }
    
    return {
      venue: "kalshi",
      venue_market_ticker: m.ticker,
      venue_event_ticker: m.event_ticker ?? null,
      venue_series_ticker: m.series_ticker ?? null,
      title: m.title,
      category: m.category ?? null,
      status: m.status,
      yes_price_last: yesPrice,
      no_price_last: noPrice,
      volume: m.volume ?? null,
      open_interest: m.open_interest ?? null,
    };
  });

  // Upsert in batches to avoid issues with large datasets
  const batchSize = 100;
  let totalUpserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { data, error, count } = await supabase
      .from("markets")
      .upsert(batch, { onConflict: "venue,venue_market_ticker", ignoreDuplicates: false })
      .select("id");

    if (error) {
      throw error;
    }

    totalUpserted += count ?? batch.length;
  }

  return totalUpserted;
}

serve(async (_req) => {
  try {
    const markets = await fetchAllOpenMarkets();
    const markets_upserted = await upsertMarkets(markets);

    return new Response(JSON.stringify({ ok: true, markets_upserted }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

