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
    const player = searchParams.get("player");
    const tier = searchParams.get("tier");

    let query = supabase
      .from("nfl_signals")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (player) {
      query = query.ilike("player_name", `%${player}%`);
    }

    if (tier) {
      query = query.eq("tier", tier);
    }

    const { data: signals, count, error } = await query;

    if (error) {
      console.error("[NFL SIGNALS API] Error fetching signals:", error);
      return NextResponse.json({ error: "Failed to fetch signals" }, { status: 500 });
    }

    return NextResponse.json({
      signals: signals || [],
      total: count || 0,
      limit,
      offset,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL SIGNALS API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL signals" }, { status: 500 });
  }
}
