import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    // Fetch trades with pagination
    const { data: trades, count, error } = await supabase
      .from("nfl_trades")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error("[NFL TRADES API] Error fetching trades:", error);
      return NextResponse.json({ error: "Failed to fetch trades" }, { status: 500 });
    }

    // Collect signal IDs from trades to fetch linked signals
    const signalIds = (trades || [])
      .map((t: any) => t.signal_id)
      .filter(Boolean);

    let signalsMap: Record<string, any> = {};
    if (signalIds.length > 0) {
      const { data: signals, error: signalsError } = await supabase
        .from("nfl_signals")
        .select("*")
        .in("id", signalIds);

      if (signalsError) {
        console.error("[NFL TRADES API] Error fetching linked signals:", signalsError);
      }

      for (const signal of signals || []) {
        signalsMap[signal.id] = signal;
      }
    }

    // Enrich trades with their primary signal
    const enrichedTrades = (trades || []).map((trade: any) => ({
      ...trade,
      primary_signal: trade.signal_id ? signalsMap[trade.signal_id] || null : null,
    }));

    return NextResponse.json({
      trades: enrichedTrades,
      total: count || 0,
      limit,
      offset,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL TRADES API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL trades" }, { status: 500 });
  }
}
