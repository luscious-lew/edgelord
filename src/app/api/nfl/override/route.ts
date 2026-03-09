import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Use service role key for write access, fall back to anon key
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type OverrideRequest =
  | { type: "kill_switch"; value: boolean }
  | { type: "kill_player"; action: "add" | "remove"; player: string }
  | { type: "max_price"; player: string; value: number }
  | { type: "confidence_boost"; player: string; value: number }
  | { type: "size_multiplier"; value: number }
  | { type: "team_needs"; team: string; needs: Record<string, string> };

export async function POST(request: Request) {
  try {
    const body: OverrideRequest = await request.json();

    if (!body.type) {
      return NextResponse.json({ error: "Missing override type" }, { status: 400 });
    }

    // Fetch current bot status
    const { data: botStatus, error: fetchError } = await supabase
      .from("bot_status")
      .select("*")
      .eq("id", "nfl-fa-bot")
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      console.error("[NFL OVERRIDE API] Error fetching bot status:", fetchError);
      return NextResponse.json({ error: "Failed to fetch bot status" }, { status: 500 });
    }

    const meta = botStatus?.meta || {};
    const overrides = meta.overrides || {};

    switch (body.type) {
      case "kill_switch": {
        overrides.kill_switch = body.value;
        break;
      }

      case "kill_player": {
        if (!body.player) {
          return NextResponse.json({ error: "Missing player name" }, { status: 400 });
        }
        const killedPlayers: string[] = overrides.killed_players || [];
        if (body.action === "add") {
          if (!killedPlayers.includes(body.player)) {
            killedPlayers.push(body.player);
          }
        } else if (body.action === "remove") {
          const idx = killedPlayers.indexOf(body.player);
          if (idx !== -1) killedPlayers.splice(idx, 1);
        } else {
          return NextResponse.json({ error: "Invalid action, must be 'add' or 'remove'" }, { status: 400 });
        }
        overrides.killed_players = killedPlayers;
        break;
      }

      case "max_price": {
        if (!body.player || body.value == null) {
          return NextResponse.json({ error: "Missing player or value" }, { status: 400 });
        }
        if (!overrides.max_prices) overrides.max_prices = {};
        overrides.max_prices[body.player] = body.value;
        break;
      }

      case "confidence_boost": {
        if (!body.player || body.value == null) {
          return NextResponse.json({ error: "Missing player or value" }, { status: 400 });
        }
        if (!overrides.confidence_boosts) overrides.confidence_boosts = {};
        overrides.confidence_boosts[body.player] = body.value;
        break;
      }

      case "size_multiplier": {
        if (body.value == null) {
          return NextResponse.json({ error: "Missing value" }, { status: 400 });
        }
        overrides.size_multiplier = body.value;
        break;
      }

      case "team_needs": {
        if (!body.team || !body.needs) {
          return NextResponse.json({ error: "Missing team or needs" }, { status: 400 });
        }
        if (!overrides.team_needs) overrides.team_needs = {};
        overrides.team_needs[body.team] = body.needs;
        break;
      }

      default:
        return NextResponse.json({ error: `Unknown override type: ${(body as any).type}` }, { status: 400 });
    }

    meta.overrides = overrides;

    // Upsert bot status with updated meta
    const { error: upsertError } = await supabase
      .from("bot_status")
      .upsert(
        {
          id: "nfl-fa-bot",
          meta,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (upsertError) {
      console.error("[NFL OVERRIDE API] Error upserting bot status:", upsertError);
      return NextResponse.json({ error: "Failed to update overrides" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      overrides,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL OVERRIDE API] Error:", error);
    return NextResponse.json({ error: "Failed to process override" }, { status: 500 });
  }
}
