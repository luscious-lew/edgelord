/**
 * Check current positions and recommend sells
 */

const KALSHI_API_KEY_ID = Deno.env.get("KALSHI_API_KEY_ID") ?? "";
const KALSHI_PRIVATE_KEY = Deno.env.get("KALSHI_PRIVATE_KEY") ?? "";

async function getHeaders(method: string, path: string) {
  const timestamp = Math.floor(Date.now()).toString();
  const msg = timestamp + method + path;
  const keyData = KALSHI_PRIVATE_KEY
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "").trim();
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, cryptoKey, new TextEncoder().encode(msg));
  return {
    "KALSHI-ACCESS-KEY": KALSHI_API_KEY_ID,
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

// Get positions
const posPath = "/trade-api/v2/portfolio/positions";
const posHeaders = await getHeaders("GET", posPath);
const posResp = await fetch("https://api.elections.kalshi.com" + posPath, { headers: posHeaders });
const posData = await posResp.json();

// Get balance
const balPath = "/trade-api/v2/portfolio/balance";
const balHeaders = await getHeaders("GET", balPath);
const balResp = await fetch("https://api.elections.kalshi.com" + balPath, { headers: balHeaders });
const balData = await balResp.json();

// Get current market prices
const mktsResp = await fetch("https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNBATRADE&status=open");
const mktsData = await mktsResp.json();
const prices: Record<string, { price: number; title: string; volume: number }> = {};
for (const m of (mktsData.markets || [])) {
  prices[m.ticker] = { price: m.last_price, title: m.title, volume: m.volume };
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("PORTFOLIO: $" + ((balData.balance + balData.portfolio_value) / 100).toFixed(2));
console.log("Cash: $" + (balData.balance / 100).toFixed(2) + " | Positions: $" + (balData.portfolio_value / 100).toFixed(2));
console.log("═══════════════════════════════════════════════════════════════");
console.log("");
console.log("YOUR POSITIONS (sorted by current price):");
console.log("───────────────────────────────────────────────────────────────");
console.log("PLAYER                  | NOW  | QTY | VALUE  | RECOMMENDATION");
console.log("───────────────────────────────────────────────────────────────");

const nba = (posData.market_positions || []).filter((p: any) => p.position !== 0 && p.ticker.includes("NBATRADE"));
const sorted = nba.sort((a: any, b: any) => (prices[b.ticker]?.price || 0) - (prices[a.ticker]?.price || 0));

let totalValue = 0;
const sellCandidates: string[] = [];
const holdCandidates: string[] = [];

for (const p of sorted) {
  const mkt = prices[p.ticker] || { price: 0, title: "", volume: 0 };
  const player = mkt.title ? (mkt.title.match(/Will (.+?) be/)?.[1] || p.ticker) : p.ticker;
  const currentPrice = mkt.price || 0;
  const contracts = Math.abs(p.position);
  const value = (currentPrice * contracts / 100);
  totalValue += value;

  let recommendation = "";
  if (currentPrice >= 90) {
    recommendation = "✅ HOLD (near lock)";
    holdCandidates.push(player);
  } else if (currentPrice >= 60) {
    recommendation = "✅ HOLD (likely)";
    holdCandidates.push(player);
  } else if (currentPrice >= 40) {
    recommendation = "⚠️  MAYBE SELL";
  } else if (currentPrice >= 25) {
    recommendation = "🔴 SELL (low odds)";
    sellCandidates.push(`${player} @ ${currentPrice}¢`);
  } else {
    recommendation = "🔴 SELL NOW (unlikely)";
    sellCandidates.push(`${player} @ ${currentPrice}¢`);
  }

  console.log(
    player.substring(0, 22).padEnd(22) + " | " +
    String(currentPrice).padStart(3) + "¢ | " +
    String(contracts).padStart(3) + " | $" +
    value.toFixed(2).padStart(5) + " | " +
    recommendation
  );
}

console.log("───────────────────────────────────────────────────────────────");
console.log(`Total position value: $${totalValue.toFixed(2)}`);
console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("SUMMARY");
console.log("═══════════════════════════════════════════════════════════════");
console.log("");
console.log("🔴 SELL THESE TO FREE UP CASH:");
for (const s of sellCandidates) {
  console.log("   • " + s);
}
console.log("");
console.log("✅ HOLD THESE (good chance of payout):");
for (const h of holdCandidates) {
  console.log("   • " + h);
}
