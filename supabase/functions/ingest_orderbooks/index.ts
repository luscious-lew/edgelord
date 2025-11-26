import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { supabase } from "../_shared/supabaseClient.ts";
import { getKalshiAuthHeaders } from "../_shared/kalshiAuth.ts";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2/markets";

type OrderbookSide = [number, number][];
type OrderbookResponse = {
  orderbook: { yes?: OrderbookSide; no?: OrderbookSide };
  yes_price?: number;
  no_price?: number;
};

type MarketRow = {
  id: string;
  venue_market_ticker: string;
};

async function fetchOpenMarkets(limit: number): Promise<MarketRow[]> {
  const { data, error } = await supabase
    .from("markets")
    .select("id, venue_market_ticker")
    .eq("venue", "kalshi")
    .eq("status", "open")
    .limit(limit);

  if (error) {
    throw error;
  }
  return data || [];
}

async function fetchOrderbook(ticker: string): Promise<OrderbookResponse> {
  const path = `/trade-api/v2/markets/${ticker}/orderbook`;
  const headers = await getKalshiAuthHeaders("GET", path);
  const response = await fetch(`${KALSHI_BASE}/${ticker}/orderbook`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch orderbook for ${ticker}: ${response.statusText}`);
  }
  return response.json();
}

async function insertQuotesForMarkets(markets: MarketRow[]): Promise<number> {
  const rows = [];
  for (const m of markets) {
    try {
      const data = await fetchOrderbook(m.venue_market_ticker);
      const ob = data.orderbook;
      const yes = ob.yes ?? [];
      const no = ob.no ?? [];
      const [yesPrice, yesQty] = yes.length ? yes[0] : [null, null];
      const [noPrice, noQty] = no.length ? no[0] : [null, null];

      rows.push({
        market_id: m.id,
        yes_best_bid: yesPrice,
        yes_best_bid_qty: yesQty,
        no_best_bid: noPrice,
        no_best_bid_qty: noQty,
        yes_price_last: data.yes_price ?? null,
        no_price_last: data.no_price ?? null,
        orderbook_raw: ob,
      });
    } catch (error) {
      console.error(`Could not process orderbook for ${m.venue_market_ticker}:`, error);
      continue;
    }
  }

  if (rows.length === 0) {
    return 0;
  }

  const { count, error } = await supabase.from("market_quotes").insert(rows);
  if (error) {
    throw error;
  }
  return count ?? 0;
}

serve(async (_req) => {
  try {
    const markets = await fetchOpenMarkets(50);
    const quotes_inserted = await insertQuotesForMarkets(markets);

    return new Response(JSON.stringify({ ok: true, quotes_inserted }), {
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

