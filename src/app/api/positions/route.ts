import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Kalshi API credentials from environment
const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID ?? "";
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY ?? "";

// Supabase client for signals data
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
    if (!KALSHI_API_KEY_ID || !KALSHI_PRIVATE_KEY) {
      return NextResponse.json({ error: "Kalshi credentials not configured" }, { status: 500 });
    }

    // Fetch positions from Kalshi
    const posPath = "/trade-api/v2/portfolio/positions";
    const posHeaders = await getKalshiHeaders("GET", posPath);
    const posResp = await fetch(`https://api.elections.kalshi.com${posPath}`, { headers: posHeaders });
    const posData = await posResp.json();

    // Fetch balance from Kalshi
    const balPath = "/trade-api/v2/portfolio/balance";
    const balHeaders = await getKalshiHeaders("GET", balPath);
    const balResp = await fetch(`https://api.elections.kalshi.com${balPath}`, { headers: balHeaders });
    const balData = await balResp.json();

    // Fetch fills to calculate cost basis (sign path without query params)
    const fillsBasePath = "/trade-api/v2/portfolio/fills";
    const fillsHeaders = await getKalshiHeaders("GET", fillsBasePath);
    const fillsResp = await fetch(`https://api.elections.kalshi.com${fillsBasePath}?limit=500`, { headers: fillsHeaders });
    const fillsData = await fillsResp.json();

    // Calculate cost basis per ticker from fills, including breakdown of buys
    type FillEntry = { price: number; count: number; side: string; created_time: string };
    const costBasis: Record<string, {
      total_cost: number;
      total_contracts: number;
      avg_price: number;
      fills: FillEntry[];
    }> = {};

    for (const fill of (fillsData.fills || [])) {
      if (!fill.ticker.includes("NBATRADE") && !fill.ticker.includes("NEXTTEAM")) continue;

      if (!costBasis[fill.ticker]) {
        costBasis[fill.ticker] = { total_cost: 0, total_contracts: 0, avg_price: 0, fills: [] };
      }

      // For buys, add to cost and track the fill
      if (fill.action === "buy") {
        // Kalshi always reports yes_price in fills
        // For NO positions, the actual price paid is 100 - yes_price
        const yesPrice = fill.yes_price ?? (fill.no_price ? 100 - fill.no_price : 0);
        const actualPrice = fill.side === "no" ? 100 - yesPrice : yesPrice;

        costBasis[fill.ticker].total_cost += actualPrice * fill.count;
        costBasis[fill.ticker].total_contracts += fill.count;
        costBasis[fill.ticker].fills.push({
          price: actualPrice,
          count: fill.count,
          side: fill.side,
          created_time: fill.created_time,
        });
      }
    }

    // Calculate average entry price and consolidate fills at same price
    for (const ticker of Object.keys(costBasis)) {
      if (costBasis[ticker].total_contracts > 0) {
        costBasis[ticker].avg_price = Math.round(costBasis[ticker].total_cost / costBasis[ticker].total_contracts);
      }
      // Consolidate fills at the same price point
      const consolidatedFills: Record<number, FillEntry> = {};
      for (const fill of costBasis[ticker].fills) {
        if (!consolidatedFills[fill.price]) {
          consolidatedFills[fill.price] = { ...fill };
        } else {
          consolidatedFills[fill.price].count += fill.count;
        }
      }
      costBasis[ticker].fills = Object.values(consolidatedFills).sort((a, b) => a.price - b.price);
    }

    // Fetch recent signals from Supabase (last 24 hours)
    const signalsSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: signalsData } = await supabase
      .from("signals")
      .select("*")
      .gte("ts", signalsSince)
      .order("ts", { ascending: false });

    // Group signals by market ticker
    const signalsByTicker: Record<string, any[]> = {};
    for (const signal of (signalsData || [])) {
      if (!signalsByTicker[signal.market_id]) {
        signalsByTicker[signal.market_id] = [];
      }
      signalsByTicker[signal.market_id].push(signal);
    }

    // Fetch price history for momentum calculation (last 6 hours)
    const priceSince = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: priceHistory } = await supabase
      .from("price_history")
      .select("ticker, price_cents, recorded_at")
      .gte("recorded_at", priceSince)
      .order("recorded_at", { ascending: true });

    // Calculate price momentum (change over last few hours)
    const priceMomentum: Record<string, { change: number; direction: "up" | "down" | "flat" }> = {};
    const priceByTicker: Record<string, number[]> = {};
    for (const ph of (priceHistory || [])) {
      if (!priceByTicker[ph.ticker]) priceByTicker[ph.ticker] = [];
      priceByTicker[ph.ticker].push(ph.price_cents);
    }
    for (const [ticker, prices] of Object.entries(priceByTicker)) {
      if (prices.length >= 2) {
        const oldPrice = prices[0];
        const newPrice = prices[prices.length - 1];
        const change = newPrice - oldPrice;
        priceMomentum[ticker] = {
          change,
          direction: change > 2 ? "up" : change < -2 ? "down" : "flat"
        };
      }
    }

    // Fetch market prices
    const mktsResp = await fetch("https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNBATRADE&status=open");
    const mktsData = await mktsResp.json();
    const tradeMarkets: Record<string, { price: number; title: string; volume: number }> = {};
    for (const m of (mktsData.markets || [])) {
      tradeMarkets[m.ticker] = { price: m.last_price, title: m.title, volume: m.volume };
    }

    // Fetch next team markets for exposure view
    const nextTeamResp = await fetch("https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNEXTTEAMNBA&status=open&limit=200");
    const nextTeamData = await nextTeamResp.json();
    const nextTeamMarkets: Record<string, { price: number; title: string; team: string; player: string }> = {};
    for (const m of (nextTeamData.markets || [])) {
      const playerMatch = m.title?.match(/what will be\s+(.+?)'s\s+next\s+team/i);
      const player = playerMatch ? playerMatch[1] : "";
      nextTeamMarkets[m.ticker] = {
        price: m.last_price,
        title: m.title,
        team: m.custom_strike?.Team || m.yes_sub_title || "",
        player: player
      };
    }

    // Process positions with smart recommendations
    const positions = (posData.market_positions || [])
      .filter((p: any) => p.position !== 0)
      .map((p: any) => {
        const isNBATrade = p.ticker.includes("NBATRADE");
        const isNextTeam = p.ticker.includes("NEXTTEAM");

        let market, playerName, currentPrice, marketType, teamCode, volume;

        if (isNBATrade) {
          market = tradeMarkets[p.ticker];
          const titleMatch = market?.title?.match(/Will\s+(.+?)\s+be\s+traded/i);
          playerName = titleMatch ? titleMatch[1] : p.ticker;
          currentPrice = market?.price || 0;
          marketType = "trade";
          volume = market?.volume || 0;
        } else if (isNextTeam) {
          market = nextTeamMarkets[p.ticker];

          // If market not in open list, parse player name from ticker
          // Ticker format: KXNEXTTEAM{PLAYER}-{YEAR}{TEAM}-{TEAMCODE}
          // Example: KXNEXTTEAMGIANNIS-26GANT-NYK
          if (market?.player) {
            playerName = market.player;
          } else {
            // Extract player name from ticker
            const tickerMatch = p.ticker.match(/KXNEXTTEAM([A-Z]+)-/i);
            if (tickerMatch) {
              // Convert to proper case (e.g., GIANNIS -> Giannis)
              const rawName = tickerMatch[1];
              playerName = rawName.charAt(0) + rawName.slice(1).toLowerCase();
              // Map common names to full names
              const nameMap: Record<string, string> = {
                "Giannis": "Giannis Antetokounmpo",
                "Lebron": "LeBron James",
                "Curry": "Stephen Curry",
                "Kd": "Kevin Durant",
                "Kawhi": "Kawhi Leonard",
                "Pg": "Paul George",
                "Ad": "Anthony Davis",
                "Jokic": "Nikola Jokic",
                "Luka": "Luka Doncic",
                "Trae": "Trae Young",
                "Ja": "Ja Morant",
                "Zion": "Zion Williamson",
                "Jimmy": "Jimmy Butler",
              };
              playerName = nameMap[playerName] || playerName;
            } else {
              playerName = p.ticker;
            }
          }

          // Extract team code from ticker if not in market data
          if (market?.team) {
            teamCode = market.team;
          } else {
            // Extract from end of ticker (e.g., -NYK)
            const teamMatch = p.ticker.match(/-([A-Z]{2,3})$/);
            teamCode = teamMatch ? teamMatch[1] : "";
          }

          currentPrice = market?.price || 0;
          marketType = "next_team";
          volume = 0; // Next team markets don't have volume in our cache
        } else {
          return null;
        }

        const contracts = Math.abs(p.position);
        const side = p.position > 0 ? "yes" : "no";

        // For YES positions, use the YES price directly
        // For NO positions, the relevant price is 100 - YES price (the NO price)
        const yesPrice = currentPrice; // This is always the YES market price
        const noPrice = 100 - yesPrice;
        const relevantPrice = side === "yes" ? yesPrice : noPrice;

        // Value is based on the actual side's price
        const value = (relevantPrice * contracts) / 100;

        // Get cost basis - this should already be the actual price paid for the side
        const basis = costBasis[p.ticker];
        // For entry price, use basis if available, otherwise estimate based on side
        const avgEntryPrice = basis?.avg_price || relevantPrice;
        // Get fills breakdown for this position
        const fills = basis?.fills || [];

        // PnL calculation: compare what we paid to current value of that side
        const pnlPerContract = relevantPrice - avgEntryPrice;
        const totalPnL = (pnlPerContract * contracts) / 100;
        const pnlPercent = avgEntryPrice > 0 ? ((pnlPerContract / avgEntryPrice) * 100) : 0;

        // Get recent signals for this ticker
        const recentSignals = signalsByTicker[p.ticker] || [];
        const twitterSignals = recentSignals.filter((s: any) => s.signal_type === "twitter_signal");
        const priceSignals = recentSignals.filter((s: any) => s.signal_type === "price_movement");

        // Get latest confidence tier from signals
        const latestConfidence = twitterSignals[0]?.meta?.confidence_tier || null;

        // Get momentum
        const momentum = priceMomentum[p.ticker] || { change: 0, direction: "flat" };

        // Generate smart recommendation (uses YES price for market state evaluation)
        const recommendation = generateRecommendation({
          side,
          currentPrice: yesPrice, // Always pass YES price for recommendation logic
          avgEntryPrice,
          pnlPercent,
          latestConfidence,
          momentum,
          signalCount: recentSignals.length,
          twitterSignalCount: twitterSignals.length,
          volume,
        });

        return {
          ticker: p.ticker,
          player_name: playerName,
          contracts,
          side,
          current_price: relevantPrice, // Use actual price for this side (NO price for NO positions)
          yes_price: yesPrice, // Always include YES price for reference
          avg_entry_price: avgEntryPrice,
          cost_basis_breakdown: fills, // Array of { price, count, side } for each buy
          pnl: totalPnL,
          pnl_percent: pnlPercent,
          value,
          market_type: marketType,
          team_code: teamCode,
          momentum: momentum.direction,
          momentum_change: momentum.change,
          recent_signals: recentSignals.slice(0, 5), // Last 5 signals
          latest_confidence: latestConfidence,
          recommendation: recommendation.action,
          recommendation_reason: recommendation.reason,
          recommendation_strength: recommendation.strength,
        };
      })
      .filter(Boolean);

    // Helper function for smart recommendations
    function generateRecommendation(data: {
      side: string;
      currentPrice: number; // YES price in cents
      avgEntryPrice: number;
      pnlPercent: number;
      latestConfidence: string | null;
      momentum: { change: number; direction: string };
      signalCount: number;
      twitterSignalCount: number;
      volume: number;
    }): { action: string; reason: string; strength: number } {
      const {
        side, currentPrice, avgEntryPrice, pnlPercent, latestConfidence,
        momentum, signalCount, twitterSignalCount
      } = data;

      const reasons: string[] = [];

      // For NO positions, we need completely different logic
      // If YES price is 98¢, NO price is 2¢ - NO position is nearly worthless
      if (side === "no") {
        const noPrice = 100 - currentPrice; // NO price in cents

        // Check if market has resolved against us (YES price very high)
        if (currentPrice >= 95) {
          // Market resolved YES - NO position is essentially worthless
          reasons.push("Market resolved YES");
          reasons.push(`NO worth only ${noPrice}¢`);
          if (latestConfidence === "Confirmed") {
            reasons.push("Trade CONFIRMED - exit if possible");
          }
          return {
            action: "loss",
            reason: reasons.join(" · "),
            strength: 0
          };
        }

        if (currentPrice >= 85) {
          reasons.push("Trade likely - NO position at risk");
          reasons.push(`NO worth ${noPrice}¢`);
          return {
            action: "sell",
            reason: reasons.join(" · "),
            strength: 1
          };
        }

        // If YES price is low, NO position is good
        if (currentPrice <= 20) {
          reasons.push("Trade unlikely - NO position winning");
          reasons.push(`NO worth ${noPrice}¢`);
          if (latestConfidence === "Negative") {
            reasons.push("Negative signal confirms");
          }
          return {
            action: "hold",
            reason: reasons.join(" · "),
            strength: 4
          };
        }

        // Middle ground - uncertain
        reasons.push(`YES at ${currentPrice}¢, NO at ${noPrice}¢`);
        if (latestConfidence === "Confirmed" || latestConfidence === "Imminent") {
          reasons.push(`${latestConfidence} signal - consider exiting NO`);
          return {
            action: "sell",
            reason: reasons.join(" · "),
            strength: 1
          };
        }

        return {
          action: "hold",
          reason: reasons.join(" · ") || "Monitoring",
          strength: 2
        };
      }

      // YES position logic (original)
      let score = 0; // Positive = bullish, negative = bearish

      // Factor 1: Current implied probability
      if (currentPrice >= 95) {
        score += 4;
        reasons.push("Near certain (95%+)");
      } else if (currentPrice >= 85) {
        score += 3;
        reasons.push("Very likely (85%+)");
      } else if (currentPrice >= 70) {
        score += 1;
        reasons.push("Probable (70%+)");
      } else if (currentPrice < 30) {
        score -= 2;
        reasons.push("Unlikely (<30%)");
      }

      // Factor 2: P&L position
      if (pnlPercent >= 50) {
        score += 1;
        reasons.push(`Strong profit (+${pnlPercent.toFixed(0)}%)`);
      } else if (pnlPercent >= 20) {
        reasons.push(`In profit (+${pnlPercent.toFixed(0)}%)`);
      } else if (pnlPercent <= -30) {
        score -= 2;
        reasons.push(`Significant loss (${pnlPercent.toFixed(0)}%)`);
      } else if (pnlPercent < 0) {
        score -= 1;
        reasons.push(`Underwater (${pnlPercent.toFixed(0)}%)`);
      }

      // Factor 3: Recent signal confidence
      if (latestConfidence === "Confirmed") {
        score += 4;
        reasons.push("CONFIRMED");
      } else if (latestConfidence === "Imminent") {
        score += 2;
        reasons.push("Imminent");
      } else if (latestConfidence === "Serious") {
        score += 1;
        reasons.push("Serious talks");
      } else if (latestConfidence === "Negative") {
        score -= 3;
        reasons.push("Deal fell through");
      } else if (twitterSignalCount === 0 && signalCount === 0) {
        score -= 1;
        reasons.push("No recent intel");
      }

      // Factor 4: Price momentum
      if (momentum.direction === "up" && momentum.change > 5) {
        score += 1;
        reasons.push(`↑${momentum.change}¢`);
      } else if (momentum.direction === "down" && momentum.change < -5) {
        score -= 1;
        reasons.push(`↓${Math.abs(momentum.change)}¢`);
      }

      // Generate recommendation based on score
      let action: string;
      let strength: number;

      // For YES positions
      if (score >= 5) {
        action = "winner";
        strength = 5;
        if (currentPrice >= 95) {
          reasons.unshift("🎉 WINNER - will resolve $1");
        }
      } else if (score >= 3) {
        action = "strong_buy";
        strength = 4;
      } else if (score >= 1) {
        action = "buy_more";
        strength = 3;
      } else if (score >= -1) {
        action = "hold";
        strength = 2;
      } else if (score >= -3) {
        action = "reduce";
        strength = 1;
      } else {
        action = "sell";
        strength = 0;
      }

      // Override: if near lock and in profit, suggest taking some off
      if (currentPrice >= 94 && currentPrice < 99 && pnlPercent >= 15) {
        action = "take_profit";
        strength = 3;
        reasons.unshift("Consider taking profit");
      }

      return {
        action,
        reason: reasons.slice(0, 3).join(" · "),
        strength
      };
    }

    // Group by player for exposure view
    const playerExposure: Record<string, {
      trade_yes: number;
      trade_no: number;
      trade_price: number;
      next_team_positions: Array<{ team: string; contracts: number; price: number }>;
    }> = {};

    for (const pos of positions) {
      if (!pos) continue;
      const name = pos.player_name.toLowerCase();

      if (!playerExposure[name]) {
        playerExposure[name] = { trade_yes: 0, trade_no: 0, trade_price: 0, next_team_positions: [] };
      }

      if (pos.market_type === "trade") {
        playerExposure[name].trade_price = pos.current_price;
        if (pos.side === "yes") {
          playerExposure[name].trade_yes = pos.contracts;
        } else {
          playerExposure[name].trade_no = pos.contracts;
        }
      } else if (pos.market_type === "next_team") {
        playerExposure[name].next_team_positions.push({
          team: pos.team_code,
          contracts: pos.contracts,
          price: pos.current_price,
        });
      }
    }

    return NextResponse.json({
      positions,
      balance: {
        cash: (balData.balance ?? 0) / 100,
        position_value: (balData.portfolio_value ?? 0) / 100,
        total: ((balData.balance ?? 0) + (balData.portfolio_value ?? 0)) / 100,
      },
      player_exposure: playerExposure,
    });
  } catch (error) {
    console.error("[POSITIONS API] Error:", error);
    return NextResponse.json({ error: "Failed to fetch positions" }, { status: 500 });
  }
}
