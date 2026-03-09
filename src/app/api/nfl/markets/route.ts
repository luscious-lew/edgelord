import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID ?? "";
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY ?? "";
const KALSHI_BASE = "https://api.elections.kalshi.com";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function pemToArrayBuffer(pem: string): ArrayBuffer {
  let normalized = pem.replace(/\s+/g, "");
  if (normalized.includes("BEGINPRIVATEKEY")) {
    normalized = normalized.replace("-----BEGINPRIVATEKEY-----", "").replace("-----ENDPRIVATEKEY-----", "");
  } else if (pem.includes("BEGIN PRIVATE KEY")) {
    normalized = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getKalshiHeaders(method: string, path: string): Promise<Headers> {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path;
  const keyBuffer = pemToArrayBuffer(KALSHI_PRIVATE_KEY);
  const privateKey = await crypto.subtle.importKey("pkcs8", keyBuffer, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, privateKey, new TextEncoder().encode(message));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

  const headers = new Headers();
  headers.set("KALSHI-ACCESS-KEY", KALSHI_API_KEY_ID);
  headers.set("KALSHI-ACCESS-TIMESTAMP", timestamp);
  headers.set("KALSHI-ACCESS-SIGNATURE", signatureB64);
  headers.set("Content-Type", "application/json");
  return headers;
}

// Paginated Kalshi market fetch
async function fetchAllMarkets(seriesTicker: string): Promise<any[]> {
  const allMarkets: any[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10; page++) { // Safety limit: max 10 pages
    let path = `/trade-api/v2/markets?series_ticker=${seriesTicker}&status=open&limit=200`;
    if (cursor) path += `&cursor=${cursor}`;

    const headers = await getKalshiHeaders("GET", path);
    const resp = await fetch(`${KALSHI_BASE}${path}`, { headers });
    if (!resp.ok) break;

    const data = await resp.json();
    allMarkets.push(...(data.markets ?? []));

    cursor = data.cursor ?? null;
    if (!cursor || (data.markets ?? []).length < 200) break; // No more pages
  }

  return allMarkets;
}

function extractPlayerName(title: string, type: "nfltrade" | "nextteam"): string | null {
  if (type === "nfltrade") {
    let m = title.match(/will\s+(.+?)\s+be\s+traded/i);
    if (m) return m[1].trim();
    m = title.match(/^(.+?)\s+traded\s+before/i);
    if (m) return m[1].trim();
    m = title.match(/will\s+(.+?)\s+sign\s+with/i);
    if (m) return m[1].trim();
    m = title.match(/will\s+(.+?)\s+leave/i);
    if (m) return m[1].trim();
  }
  if (type === "nextteam") {
    let m = title.match(/what will be (.+?)(?:'s|'s) next team/i);
    if (m) return m[1].trim();
    m = title.match(/^(.+?)(?:'s|'s) next team/i);
    if (m) return m[1].trim();
  }
  return null;
}

export async function GET() {
  try {
    if (!KALSHI_API_KEY_ID || !KALSHI_PRIVATE_KEY) {
      return NextResponse.json({ error: "Kalshi credentials not configured" }, { status: 500 });
    }

    // Fetch all markets with pagination
    const [tradeRaw, nextRaw] = await Promise.all([
      fetchAllMarkets("KXNFLTRADE"),
      fetchAllMarkets("KXNEXTTEAMNFL"),
    ]);

    // Fetch our positions
    const posPath = "/trade-api/v2/portfolio/positions";
    const posHeaders = await getKalshiHeaders("GET", posPath);
    const posResp = await fetch(`${KALSHI_BASE}${posPath}`, { headers: posHeaders });
    const posData = await posResp.json();
    const positionsByTicker = new Map<string, any>();
    for (const p of posData.market_positions ?? []) {
      if (p.position !== 0 || p.no_position !== 0) {
        positionsByTicker.set(p.ticker, p);
      }
    }

    // Fetch signal counts per player (last 48h)
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: signals } = await supabase
      .from("nfl_signals")
      .select("player_name")
      .gte("created_at", since48h);

    const signalCountByPlayer = new Map<string, number>();
    for (const s of signals ?? []) {
      const key = (s.player_name || "").toLowerCase();
      signalCountByPlayer.set(key, (signalCountByPlayer.get(key) ?? 0) + 1);
    }

    // Build NFLTRADE list
    const tradeMarkets = tradeRaw.map((m: any) => {
      const pos = positionsByTicker.get(m.ticker);
      const playerName = extractPlayerName(m.title ?? "", "nfltrade") ?? m.ticker;
      return {
        ticker: m.ticker,
        player_name: playerName,
        title: m.title,
        yes_price: m.last_price ?? 50,
        volume: m.volume ?? 0,
        open_interest: m.open_interest ?? 0,
        signal_count: signalCountByPlayer.get(playerName.toLowerCase()) ?? 0,
        position: pos ? {
          side: pos.position > 0 ? "yes" : "no",
          contracts: pos.position > 0 ? pos.position : pos.no_position,
        } : null,
      };
    }).sort((a: any, b: any) => b.yes_price - a.yes_price);

    // Build NEXTTEAM grouped by player
    const nextTeamByPlayer = new Map<string, {
      player_name: string;
      total_volume: number;
      teams: { ticker: string; team: string; yes_price: number; volume: number; position: any }[];
    }>();

    for (const m of nextRaw) {
      const playerName = extractPlayerName(m.title ?? "", "nextteam");
      if (!playerName) continue;

      const key = playerName.toLowerCase();
      if (!nextTeamByPlayer.has(key)) {
        nextTeamByPlayer.set(key, { player_name: playerName, total_volume: 0, teams: [] });
      }

      const team = m.yes_sub_title || m.custom_strike?.Team || m.ticker.split("-").pop() || "Unknown";
      const pos = positionsByTicker.get(m.ticker);

      const entry = nextTeamByPlayer.get(key)!;
      entry.total_volume += m.volume ?? 0;
      entry.teams.push({
        ticker: m.ticker,
        team,
        yes_price: m.last_price ?? 0,
        volume: m.volume ?? 0,
        position: pos ? {
          side: pos.position > 0 ? "yes" : "no",
          contracts: pos.position > 0 ? pos.position : pos.no_position,
        } : null,
      });
    }

    const nextTeamPlayers = Array.from(nextTeamByPlayer.values()).map(p => ({
      ...p,
      teams: p.teams.sort((a, b) => b.yes_price - a.yes_price),
      top_price: p.teams.reduce((max, t) => Math.max(max, t.yes_price), 0),
      signal_count: signalCountByPlayer.get(p.player_name.toLowerCase()) ?? 0,
      has_position: p.teams.some(t => t.position !== null),
    })).sort((a, b) => b.top_price - a.top_price);

    return NextResponse.json({
      trade_markets: tradeMarkets,
      next_team_players: nextTeamPlayers,
      counts: {
        trade_markets: tradeMarkets.length,
        next_team_players: nextTeamPlayers.length,
        next_team_markets: nextRaw.length,
      },
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL MARKETS API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL markets" }, { status: 500 });
  }
}
