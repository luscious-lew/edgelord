import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  try {
    const { data: events, error } = await supabase
      .from("nfl_arbitrage_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("[NFL ARBITRAGE API] Error fetching arbitrage events:", error);
      return NextResponse.json({ error: "Failed to fetch arbitrage events" }, { status: 500 });
    }

    return NextResponse.json({
      events: events || [],
      total: (events || []).length,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL ARBITRAGE API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL arbitrage events" }, { status: 500 });
  }
}
