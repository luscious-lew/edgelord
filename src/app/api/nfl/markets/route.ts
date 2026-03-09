import { NextResponse } from "next/server";

const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID ?? "";
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY ?? "";
const KALSHI_BASE = "https://api.elections.kalshi.com";

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

    // Fetch NFLTRADE markets
    const tradePath = "/trade-api/v2/markets?series_ticker=KXNFLTRADE&status=open&limit=200";
    const tradeHeaders = await getKalshiHeaders("GET", tradePath);
    const tradeResp = await fetch(`${KALSHI_BASE}${tradePath}`, { headers: tradeHeaders });
    const tradeData = await tradeResp.json();

    // Fetch NEXTTEAM markets
    const nextPath = "/trade-api/v2/markets?series_ticker=KXNEXTTEAMNFL&status=open&limit=200";
    const nextHeaders = await getKalshiHeaders("GET", nextPath);
    const nextResp = await fetch(`${KALSHI_BASE}${nextPath}`, { headers: nextHeaders });
    const nextData = await nextResp.json();

    // Build NFLTRADE list
    const tradeMarkets = (tradeData.markets ?? []).map((m: any) => ({
      ticker: m.ticker,
      player_name: extractPlayerName(m.title ?? "", "nfltrade") ?? m.ticker,
      title: m.title,
      yes_price: m.last_price ?? 50,
      volume: m.volume ?? 0,
      open_interest: m.open_interest ?? 0,
    })).sort((a: any, b: any) => b.yes_price - a.yes_price);

    // Build NEXTTEAM grouped by player
    const nextTeamByPlayer = new Map<string, {
      player_name: string;
      teams: { ticker: string; team: string; yes_price: number; volume: number }[];
    }>();

    for (const m of nextData.markets ?? []) {
      const playerName = extractPlayerName(m.title ?? "", "nextteam");
      if (!playerName) continue;

      const key = playerName.toLowerCase();
      if (!nextTeamByPlayer.has(key)) {
        nextTeamByPlayer.set(key, { player_name: playerName, teams: [] });
      }

      // Extract team from subtitle or custom_strike
      const team = m.yes_sub_title || m.custom_strike?.Team || m.ticker.split("-").pop() || "Unknown";

      nextTeamByPlayer.get(key)!.teams.push({
        ticker: m.ticker,
        team,
        yes_price: m.last_price ?? 0,
        volume: m.volume ?? 0,
      });
    }

    // Sort teams within each player by price descending
    const nextTeamPlayers = Array.from(nextTeamByPlayer.values()).map(p => ({
      ...p,
      teams: p.teams.sort((a, b) => b.yes_price - a.yes_price),
      top_price: p.teams.reduce((max, t) => Math.max(max, t.yes_price), 0),
    })).sort((a, b) => b.top_price - a.top_price);

    return NextResponse.json({
      trade_markets: tradeMarkets,
      next_team_players: nextTeamPlayers,
      counts: {
        trade_markets: tradeMarkets.length,
        next_team_players: nextTeamPlayers.length,
        next_team_markets: (nextData.markets ?? []).length,
      },
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL MARKETS API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL markets" }, { status: 500 });
  }
}
