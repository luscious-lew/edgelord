import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  try {
    // Fetch all players from nfl_context
    const { data: players, error: playersError } = await supabase
      .from("nfl_context")
      .select("*")
      .eq("entity_type", "player")
      .order("entity_name", { ascending: true });

    if (playersError) {
      console.error("[NFL PLAYERS API] Error fetching players:", playersError);
      return NextResponse.json({ error: "Failed to fetch players" }, { status: 500 });
    }

    // Fetch recent signals (last 48h)
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: signals, error: signalsError } = await supabase
      .from("nfl_signals")
      .select("*")
      .gte("created_at", since48h)
      .order("created_at", { ascending: false });

    if (signalsError) {
      console.error("[NFL PLAYERS API] Error fetching signals:", signalsError);
    }

    // Fetch active trades
    const { data: trades, error: tradesError } = await supabase
      .from("nfl_trades")
      .select("*")
      .order("created_at", { ascending: false });

    if (tradesError) {
      console.error("[NFL PLAYERS API] Error fetching trades:", tradesError);
    }

    // Group signals by player name
    const signalsByPlayer: Record<string, any[]> = {};
    for (const signal of signals || []) {
      const playerName = signal.player_name || signal.meta?.player_name;
      if (!playerName) continue;
      const key = playerName.toLowerCase();
      if (!signalsByPlayer[key]) signalsByPlayer[key] = [];
      signalsByPlayer[key].push(signal);
    }

    // Group trades by player name
    const tradesByPlayer: Record<string, any[]> = {};
    for (const trade of trades || []) {
      const playerName = trade.player_name || trade.meta?.player_name;
      if (!playerName) continue;
      const key = playerName.toLowerCase();
      if (!tradesByPlayer[key]) tradesByPlayer[key] = [];
      tradesByPlayer[key].push(trade);
    }

    // Enrich players with signals and trades
    const enrichedPlayers = (players || []).map((player: any) => {
      const key = (player.entity_name || "").toLowerCase();
      return {
        ...player,
        recent_signals: signalsByPlayer[key] || [],
        trades: tradesByPlayer[key] || [],
        signal_count: (signalsByPlayer[key] || []).length,
        trade_count: (tradesByPlayer[key] || []).length,
      };
    });

    return NextResponse.json({
      players: enrichedPlayers,
      total: enrichedPlayers.length,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL PLAYERS API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL players" }, { status: 500 });
  }
}
