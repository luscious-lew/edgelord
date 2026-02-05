// Load NBA trade markets from Kalshi into Supabase
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hquevhjfozjqgciieqsl.supabase.co";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function loadMarkets() {
  console.log("Fetching NBA trade markets from Kalshi...");

  const response = await fetch(
    "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNBATRADE&status=open"
  );

  if (!response.ok) {
    console.error("Failed to fetch markets:", response.status);
    return;
  }

  const data = await response.json();
  console.log(`Found ${data.markets.length} markets`);

  const markets = data.markets.map((m: any) => ({
    venue: "kalshi",
    venue_market_ticker: m.ticker,
    venue_event_ticker: m.event_ticker,
    venue_series_ticker: "KXNBATRADE",
    title: m.title,
    category: "sports",
    status: m.status === "active" ? "open" : m.status,
    yes_price_last: m.last_price / 100,
    no_price_last: (100 - m.last_price) / 100,
    volume: m.volume,
    open_interest: m.open_interest,
  }));

  const { data: result, error } = await supabase
    .from("markets")
    .upsert(markets, { onConflict: "venue,venue_market_ticker" })
    .select("venue_market_ticker, title, yes_price_last");

  if (error) {
    console.error("Error inserting markets:", error);
    return;
  }

  console.log(`\n✅ Loaded ${result.length} NBA trade markets:\n`);
  result.forEach((m: any) => {
    const price = Math.round(m.yes_price_last * 100);
    console.log(`  ${m.venue_market_ticker.padEnd(25)} ${price}¢  ${m.title}`);
  });
}

loadMarkets();
