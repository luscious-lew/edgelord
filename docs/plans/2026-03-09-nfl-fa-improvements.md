# NFL FA Bot Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix event type misclassification bug, wire up dashboard trade tracking, and reduce signal-to-trade latency.

**Architecture:** Three independent workstreams in one file (bot) and two files (dashboard). The classification fix adds validation in the synthetic signal path. Dashboard wiring connects existing API data to existing UI scaffolding. Latency improvements tighten polling intervals and reorder the signal processing pipeline to fire orders before DB writes.

**Tech Stack:** Deno (bot), Next.js/React (dashboard), Supabase (DB), Kalshi API, Twitter API v2, Groq LLM

---

## Workstream 1: Event Type Classification Fix

### Task 1: Add trade/signing distinction to deep analysis LLM prompt

**Files:**
- Modify: `scripts/nfl-fa-bot.ts:1503-1518` (deep analysis system prompt)

**Step 1: Add explicit event type instructions to the LLM prompt**

In the `runDeepAnalysis()` function, add this constraint after the existing analysis instructions (line 1517, before the "Respond with JSON only" line):

```typescript
// Replace line 1518:
// Respond with JSON only.`;
// With:
CRITICAL EVENT TYPE RULES:
- "trade" = a team-to-team deal where a player is traded WITH draft pick/player compensation. One team sends the player, another receives them.
- "signing" = a player signs with a new team in free agency. This includes "has agreed to a deal", "is signing with", "reached agreement". A player changing teams via free agency is ALWAYS "signing", NEVER "trade".
- "cut"/"release" = a player is released/cut by their current team
- "extension" = a player extends their contract with their CURRENT team
- If multiple signals discuss a player "agreeing to a deal" or "signing with" a team, the event_type MUST be "signing", not "trade".

Respond with JSON only.`;
```

**Step 2: Verify the prompt change compiles**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && deno check scripts/nfl-fa-bot.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "fix: add trade vs signing distinction to deep analysis LLM prompt"
```

---

### Task 2: Add runtime validation in processSignalStack

**Files:**
- Modify: `scripts/nfl-fa-bot.ts:1772-1835` (processSignalStack function)

**Step 1: Cross-validate event type against source signals**

Replace the synthetic signal event type assignment at line 1808 with validation logic. The key insight: if we query the recent signals for this player and ALL of them say "signing", the LLM shouldn't override to "trade".

```typescript
// Replace line 1808:
// eventType: (stack.event_type as EventType) ?? "signing",
// With this block (insert before the syntheticSignal construction):

  // Validate event type: don't let LLM override to "trade" if all source signals say "signing"
  const VALID_EVENT_TYPES: EventType[] = ["trade", "signing", "cut", "release", "extension", "rumor", "cap_move"];
  let validatedEventType: EventType = VALID_EVENT_TYPES.includes(stack.event_type as EventType)
    ? (stack.event_type as EventType)
    : "rumor"; // Default to rumor (no trade action), not signing

  // Cross-validate "trade" classification against source signals
  if (validatedEventType === "trade") {
    const playerSignals = recentSignals.filter(
      s => s.playerName.toLowerCase() === stack.player_name.toLowerCase()
    );
    const hasTradeSignal = playerSignals.some(s => s.eventType === "trade");
    if (!hasTradeSignal && playerSignals.length > 0) {
      // No source signal mentions a trade — LLM is likely confusing signing with trade
      const dominantType = playerSignals.filter(s => s.eventType === "signing").length > 0
        ? "signing" : "rumor";
      console.log(`[STACK] Overriding LLM event_type "trade" → "${dominantType}" for ${stack.player_name} (no source signals mention trade)`);
      validatedEventType = dominantType;
    }
  }

// Then in the syntheticSignal object, use:
    eventType: validatedEventType,
```

**Step 2: Verify compiles**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && deno check scripts/nfl-fa-bot.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "fix: validate synthetic signal event types against source signals"
```

---

## Workstream 2: Dashboard Trade Tracking

### Task 3: Wire up trade_history in fetchPlayers

**Files:**
- Modify: `src/app/nfl-fa/page.tsx:718-755` (fetchPlayers function)

**Step 1: Map trades data to trade_history field**

The `/api/nfl/players` endpoint already returns `trades` array per player (line 71 of route.ts). The dashboard just doesn't map it. Add the mapping in `fetchPlayers()`:

```typescript
// In the mapped PlayerCard object (after line 746: analyst_context: p.context_summary,)
// Add:
          trade_history: (p.trades ?? []).map((t: any) => ({
            id: t.id,
            side: t.side,
            action: t.action,
            price: t.price_cents,
            count: t.quantity,
            created_at: t.created_at,
            reason: `${t.meta?.event_type ?? ""} ${t.market_type ?? ""} ${t.market_ticker ?? ""}`,
          })),
```

**Step 2: Verify the dashboard builds**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && npx next build 2>&1 | tail -20`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/app/nfl-fa/page.tsx
git commit -m "feat: wire up trade history data in NFL FA dashboard"
```

---

### Task 4: Wire up position_held from Kalshi positions

**Files:**
- Modify: `src/app/api/nfl/status/route.ts:73-82` (positions fetch)
- Modify: `src/app/api/nfl/players/route.ts` (add positions data)
- Modify: `src/app/nfl-fa/page.tsx:718-755` (fetchPlayers mapping)

**Step 1: Return positions data from the status API**

In `src/app/api/nfl/status/route.ts`, change line 79-81 to also return the raw positions array:

```typescript
// Replace lines 79-82 with:
      const nflPositions = (posData.market_positions || []).filter(
        (p: any) => (p.position !== 0 || p.no_position !== 0) &&
          (p.ticker.includes("NFLTRADE") || p.ticker.includes("NEXTTEAMNFL") || p.ticker.includes("NFLFA"))
      );
      activePositionsCount = nflPositions.length;
```

And add `positions: nflPositions` to the response JSON (line 93-99):

```typescript
    return NextResponse.json({
      bot_status: botStatus || null,
      balance,
      active_positions: activePositionsCount,
      positions: KALSHI_API_KEY_ID ? nflPositions : [],
      total_trades: tradesCount || 0,
      fetched_at: new Date().toISOString(),
    });
```

**Step 2: Use positions in the dashboard**

In `src/app/nfl-fa/page.tsx`, update `fetchStatus` to store positions, then use them in `fetchPlayers`.

Add a new state variable after line 714:

```typescript
const [positions, setPositions] = useState<any[]>([]);
```

In `fetchStatus` (around line 777-794), add after setting bot status:

```typescript
      if (data.positions) {
        setPositions(data.positions);
      }
```

In `fetchPlayers` mapping, add position data lookup. After the `trade_history` mapping, add:

```typescript
          position_held: (() => {
            // Find position matching this player's markets
            const playerTrades = p.trades ?? [];
            const tickers = playerTrades.map((t: any) => t.market_ticker).filter(Boolean);
            const pos = positions.find((pos: any) => tickers.includes(pos.ticker));
            if (!pos) return undefined;
            const side = pos.position > 0 ? "yes" : "no";
            const contracts = pos.position > 0 ? pos.position : pos.no_position;
            const avgEntry = side === "yes" ? (pos.average_price_paid ?? 0) : (100 - (pos.average_price_paid ?? 0));
            const currentValue = side === "yes" ? (pos.market_price ?? 0) : (100 - (pos.market_price ?? 0));
            return {
              side,
              contracts,
              avg_entry: avgEntry,
              current_value: currentValue,
              unrealized_pnl: (currentValue - avgEntry) * contracts,
            };
          })(),
```

**Step 3: Verify build**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && npx next build 2>&1 | tail -20`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/app/api/nfl/status/route.ts src/app/nfl-fa/page.tsx
git commit -m "feat: wire up position data and P&L in NFL FA dashboard"
```

---

### Task 5: Add primary_signal_id to bot trade inserts

**Files:**
- Modify: `scripts/nfl-fa-bot.ts:432-455` (nfl_trades insert in placeOrder)

**Step 1: Add signal ID and confidence fields to trade insert**

The `placeOrder` function receives the full signal object. Use it to populate the missing columns:

```typescript
// Replace lines 433-455 with:
      await supabase.from("nfl_trades").insert({
        market_ticker: ticker,
        order_id: result.order?.order_id || clientOrderId,
        side,
        action: "buy",
        price_cents: priceCents,
        quantity: quantity,
        market_type: ticker.includes("NFLTRADE") ? "nfltrade" : "nextteam",
        status: result.order?.status || "submitted",
        primary_signal_id: signal.id || null,
        confidence_tier_at_trade: signal.confidenceTier,
        confidence_score_at_trade: signal.confidenceScore,
        meta: {
          source: BOT_ID,
          client_order_id: clientOrderId,
          player_name: signal.playerName,
          event_type: signal.eventType,
          confidence_tier: signal.confidenceTier,
          destination_team: signal.destinationTeam,
          tweet_id: signal.tweetId,
          tweet_text: signal.tweetText,
          source_handle: signal.sourceHandle,
          source_tier: signal.sourceTier,
          fast_path_match: signal.fastPathMatch,
        },
      });
```

**Step 2: Verify compiles**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && deno check scripts/nfl-fa-bot.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "feat: populate primary_signal_id and confidence fields in trade inserts"
```

---

## Workstream 3: Latency Improvements

### Task 6: Reduce Tier 1 polling interval to 1.5s

**Files:**
- Modify: `scripts/nfl-fa-bot.ts:97-100` (TIER_POLL_MS)

**Step 1: Change Tier 1 interval**

```typescript
// Replace lines 97-100:
const TIER_POLL_MS: Record<number, number> = {
  1: 1_500,   // Was 3_000 — tighter polling for Tier 1 insiders
  2: 15_000,
  3: 60_000,
};
```

**Step 2: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "perf: reduce Tier 1 Twitter polling interval from 3s to 1.5s"
```

---

### Task 7: Fire orders before saving signal to DB

**Files:**
- Modify: `scripts/nfl-fa-bot.ts:907-1008` (processTweet function)

**Step 1: Reorder signal processing to fire orders first**

In the fast-path branch (lines 937-948), change the order so we execute trades before saving to Supabase. The key change is in the parallel execution block:

```typescript
    // Replace lines 937-948 with:
    // Fire trade FIRST (don't wait for DB save), then LLM in parallel
    const [, llmResult] = await Promise.all([
      (async () => {
        if (signal.playerName !== "UNKNOWN") {
          // Execute trade immediately — don't wait for DB save
          await executeTradesForSignal(signal);
          // Save to DB in background (non-blocking)
          saveSignal(signal).catch(e => console.error("[SIGNAL] Background save error:", e));
        } else {
          console.log("[SIGNAL] Fast path skipped trade: no player identified");
        }
      })(),
      classifyWithLLM(tweet.text, source),
    ]);
```

For the slow path (lines 1005-1006), same reorder:

```typescript
    // Replace lines 1005-1006 with:
    await executeTradesForSignal(signal);
    saveSignal(signal).catch(e => console.error("[SIGNAL] Background save error:", e));
```

**Step 2: Verify compiles**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && deno check scripts/nfl-fa-bot.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "perf: fire orders before DB save to reduce latency ~200ms"
```

---

### Task 8: Pre-cache order parameters for known players

**Files:**
- Modify: `scripts/nfl-fa-bot.ts` (add pre-computed order cache after market refresh)

**Step 1: Add order parameter cache**

After the `refreshMarkets()` function (around line 656), add a pre-computation step:

```typescript
// Pre-computed order parameters for instant execution
interface PrecomputedOrder {
  ticker: string;
  side: "yes" | "no";
  maxPrice: number;
  quantity: number;
}

const precomputedOrders = new Map<string, PrecomputedOrder[]>();

function precomputeOrders(): void {
  precomputedOrders.clear();
  for (const [playerKey, pm] of playerMarkets) {
    const orders: PrecomputedOrder[] = [];

    // Pre-compute for confirmed signing → YES on top 3 nextteam markets
    if (pm.nextTeamMarkets.size > 0) {
      const topTeams = Array.from(pm.nextTeamMarkets.entries())
        .sort((a, b) => b[1].yesPrice - a[1].yesPrice)
        .slice(0, 3);
      for (const [_code, market] of topTeams) {
        if (market.yesPrice < 98) {
          orders.push({
            ticker: market.ticker,
            side: "yes",
            maxPrice: CONFIDENCE_CONFIG.confirmed.maxPrice,
            quantity: calculateQuantity(CONFIDENCE_CONFIG.confirmed.maxPrice, CONFIDENCE_CONFIG.confirmed.sizeMultiplier),
          });
        }
      }
    }

    // Pre-compute for confirmed trade → YES on NFLTRADE
    if (pm.tradeMarket && pm.tradeMarket.yesPrice < 98) {
      orders.push({
        ticker: pm.tradeMarket.ticker,
        side: "yes",
        maxPrice: CONFIDENCE_CONFIG.confirmed.maxPrice,
        quantity: calculateQuantity(CONFIDENCE_CONFIG.confirmed.maxPrice, CONFIDENCE_CONFIG.confirmed.sizeMultiplier),
      });
    }

    if (orders.length > 0) {
      precomputedOrders.set(playerKey, orders);
    }
  }
  console.log(`[CACHE] Pre-computed orders for ${precomputedOrders.size} players`);
}
```

Then call `precomputeOrders()` at the end of `refreshMarkets()` (after the market sync, around line 655):

```typescript
  precomputeOrders();
```

**Step 2: Verify compiles**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && deno check scripts/nfl-fa-bot.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "perf: pre-compute order parameters on market refresh for faster execution"
```

---

### Task 9: Reduce market refresh interval to 15s

**Files:**
- Modify: `scripts/nfl-fa-bot.ts:37` (MARKET_REFRESH_MS)

**Step 1: Change market refresh interval**

```typescript
// Replace line 37:
const MARKET_REFRESH_MS = 15_000; // Was 30_000 — more current prices
```

**Step 2: Commit**

```bash
git add scripts/nfl-fa-bot.ts
git commit -m "perf: reduce market refresh interval from 30s to 15s"
```

---

### Task 10: Final verification and deploy

**Step 1: Verify bot compiles**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && deno check scripts/nfl-fa-bot.ts`
Expected: No errors

**Step 2: Verify dashboard builds**

Run: `cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord && npx next build 2>&1 | tail -20`
Expected: Build succeeds

**Step 3: Commit and push**

```bash
git add -A
git commit -m "chore: final verification of all improvements"
git push origin main
```
