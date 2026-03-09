import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  try {
    const { data: teams, error } = await supabase
      .from("nfl_context")
      .select("*")
      .eq("entity_type", "team")
      .order("entity_name", { ascending: true });

    if (error) {
      console.error("[NFL TEAMS API] Error fetching teams:", error);
      return NextResponse.json({ error: "Failed to fetch teams" }, { status: 500 });
    }

    return NextResponse.json({
      teams: teams || [],
      total: (teams || []).length,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL TEAMS API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL teams" }, { status: 500 });
  }
}
