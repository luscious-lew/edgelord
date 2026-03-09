import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Extract player name from market title
function extractPlayer(title: string): string | null {
  // NFLTRADE: "Will Patrick Mahomes be traded?"
  let m = title.match(/will\s+(.+?)\s+be\s+traded/i);
  if (m) return m[1].trim();
  m = title.match(/^(.+?)\s+traded\s+before/i);
  if (m) return m[1].trim();
  m = title.match(/will\s+(.+?)\s+sign\s+with/i);
  if (m) return m[1].trim();
  m = title.match(/will\s+(.+?)\s+leave/i);
  if (m) return m[1].trim();
  // NEXTTEAM: "What will be X's next team?" or "X's Next Team"
  m = title.match(/what will be (.+?)(?:'s|'s) next team/i);
  if (m) return m[1].trim();
  m = title.match(/^(.+?)(?:'s|'s) next team/i);
  if (m) return m[1].trim();
  return null;
}

// Extract team from NEXTTEAM title
function extractTeam(title: string): string | null {
  const m = title.match(/next team[^:]*:\s*(.+)/i);
  if (m) return m[1].trim();
  return null;
}

interface PlayerMarketData {
  player_name: string;
  trade_market: {
    ticker: string;
    yes_price: number;
    title: string;
  } | null;
  next_team_markets: {
    ticker: string;
    team: string;
    yes_price: number;
    title: string;
  }[];
  total_markets: number;
}

export async function GET() {
  try {
    // Fetch all NFL markets from the markets table
    const { data: markets, error } = await supabase
      .from("markets")
      .select("*")
      .or("venue_series_ticker.eq.KXNFLTRADE,venue_series_ticker.eq.KXNEXTTEAMNFL")
      .eq("status", "open")
      .order("title", { ascending: true });

    if (error) {
      console.error("[NFL MARKETS API] Error:", error);
      return NextResponse.json({ error: "Failed to fetch markets" }, { status: 500 });
    }

    // Group by player
    const playerMap = new Map<string, PlayerMarketData>();

    for (const market of markets || []) {
      const playerName = extractPlayer(market.title || "");
      if (!playerName) continue;

      const key = playerName.toLowerCase();
      if (!playerMap.has(key)) {
        playerMap.set(key, {
          player_name: playerName,
          trade_market: null,
          next_team_markets: [],
          total_markets: 0,
        });
      }

      const pm = playerMap.get(key)!;
      const yesPrice = Math.round((market.yes_price_last ?? 0) * 100);

      if (market.venue_series_ticker === "KXNFLTRADE") {
        pm.trade_market = {
          ticker: market.venue_market_ticker,
          yes_price: yesPrice,
          title: market.title,
        };
      } else if (market.venue_series_ticker === "KXNEXTTEAMNFL") {
        const team = extractTeam(market.title) || market.venue_market_ticker;
        pm.next_team_markets.push({
          ticker: market.venue_market_ticker,
          team,
          yes_price: yesPrice,
          title: market.title,
        });
      }

      pm.total_markets++;
    }

    // Sort next_team_markets by price descending
    for (const pm of playerMap.values()) {
      pm.next_team_markets.sort((a, b) => b.yes_price - a.yes_price);
    }

    // Convert to array, sort by trade market price (most active first)
    const players = Array.from(playerMap.values()).sort((a, b) => {
      const aPrice = a.trade_market?.yes_price ?? 0;
      const bPrice = b.trade_market?.yes_price ?? 0;
      // Sort by trade price descending (most likely to move first), then by total markets
      return bPrice - aPrice || b.total_markets - a.total_markets;
    });

    return NextResponse.json({
      players,
      total_markets: (markets || []).length,
      total_players: players.length,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL MARKETS API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL markets" }, { status: 500 });
  }
}
