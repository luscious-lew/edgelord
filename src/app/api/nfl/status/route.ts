import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Kalshi API credentials from environment
const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID ?? "";
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY ?? "";

// Supabase client
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

export async function GET() {
  try {
    // Fetch bot status from Supabase
    const { data: botStatus, error: statusError } = await supabase
      .from("bot_status")
      .select("*")
      .eq("id", "nfl-fa-bot")
      .single();

    if (statusError) {
      console.error("[NFL STATUS API] Error fetching bot status:", statusError);
    }

    // Fetch Kalshi balance and portfolio
    let balance = null;
    let activePositionsCount = 0;

    if (KALSHI_API_KEY_ID && KALSHI_PRIVATE_KEY) {
      // Fetch balance
      const balPath = "/trade-api/v2/portfolio/balance";
      const balHeaders = await getKalshiHeaders("GET", balPath);
      const balResp = await fetch(`https://api.elections.kalshi.com${balPath}`, { headers: balHeaders });
      const balData = await balResp.json();

      balance = {
        cash: (balData.balance ?? 0) / 100,
        portfolio_value: (balData.portfolio_value ?? 0) / 100,
        total: ((balData.balance ?? 0) + (balData.portfolio_value ?? 0)) / 100,
      };

      // Fetch positions to count active NFL ones
      const posPath = "/trade-api/v2/portfolio/positions";
      const posHeaders = await getKalshiHeaders("GET", posPath);
      const posResp = await fetch(`https://api.elections.kalshi.com${posPath}`, { headers: posHeaders });
      const posData = await posResp.json();

      activePositionsCount = (posData.market_positions || []).filter(
        (p: any) => p.position !== 0 && (p.ticker.includes("NFLFA") || p.ticker.includes("NEXTTEAMNFL"))
      ).length;
    }

    // Count total nfl_trades
    const { count: tradesCount, error: tradesError } = await supabase
      .from("nfl_trades")
      .select("*", { count: "exact", head: true });

    if (tradesError) {
      console.error("[NFL STATUS API] Error counting trades:", tradesError);
    }

    return NextResponse.json({
      bot_status: botStatus || null,
      balance,
      active_positions: activePositionsCount,
      total_trades: tradesCount || 0,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[NFL STATUS API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch NFL bot status" }, { status: 500 });
  }
}
