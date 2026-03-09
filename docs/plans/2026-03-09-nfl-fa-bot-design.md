# NFL Free Agency & Trade Bot — Design Document

**Date**: 2026-03-09
**Status**: Approved
**Markets**: KXNFLTRADE (player traded?), KXNEXTTEAMNFL (player's next team)

## Overview

An automated Kalshi trading bot that monitors NFL free agency and trade activity, combining instant news-reactive trading with a contextual "analyst brain" that builds conviction over time. Adapts proven patterns from the NBA trade bot and Super Bowl ad bot while addressing their shortcomings.

## Market Rules (Critical)

### NFLTRADE — "Will [Player] be traded?"

- Resolves YES only on actual **trades** (rights transferred between teams)
- Includes: player-for-player, player-for-picks, player-for-cash, sign-and-trade, draft day trades
- Does NOT include: free agent signings, waivers, releases, cuts, draft selection, waiver claims
- Even if trade is later rescinded, still resolves YES
- Source Agencies: official transaction wire, ESPN, The Athletic, AP, NYT, Bloomberg, Reuters, WaPo, WSJ, ABC/CBS/NBC/Fox Sports, Bleacher Report, Yahoo Sports, team official websites/social media

### NEXTTEAM — "[Player]'s next team"

- Resolves to the **first new team** player officially joins after issuance
- "Officially joins" = signing a contract (any duration), official trade, waiver claim, draft, international signing
- Sign-and-trades resolve to the **final destination team**, not the initial signing team
- Multi-team trades resolve to the team acquiring player's rights
- Rights trades don't count until a contract is signed
- Verbal agreements NOT yet made official don't count
- Source Agencies: league office, team websites/social media, ESPN, The Athletic, NYT, Bloomberg, Reuters, Axios, AP, Politico, Semafor, The Information, WaPo, ABC, CBS, CNN, Fox News, Fox Sports, MSNBC, NBC, NBC Sports, Bleacher Report, player's official social media

### Key Distinction

A single event can trigger different actions across markets:
- Player **traded** to Team X → Buy YES on NFLTRADE + Buy YES on NEXTTEAM-TeamX
- Player **signs as FA** with Team X → Buy YES on NEXTTEAM-TeamX only (NOT NFLTRADE)
- Player **cut/released** → Consider NO on NFLTRADE (can't be traded if not under contract)
- Player **extends** with current team → Buy YES on NEXTTEAM-SameTeam, Buy NO on NFLTRADE

## Architecture: Two-Speed Intelligence

### System 1 — Instant Reactive Trading

Triggered per-tweet with minimal latency. Target: < 8 seconds from tweet → order on book.

**Pipeline:**
```
Tweet detected (T+0s)
  ├── Regex fast-path (T+0.1s)
  │   "has been traded to", "is being traded to", "has agreed to"
  │   → Place order immediately (T+0.5s)
  │   → LLM confirms in parallel → cancel if misclassified (T+3s)
  │
  └── LLM fast classification (T+2-3s)
      → Classify: player, team, event_type, confidence, language_pattern
      → Place order if confidence >= developing (T+3.5s)
```

**Latency optimizations:**
- Regex fast-path bypasses LLM for unambiguous confirmed-deal language
- Pre-warmed player→market ticker lookup (refreshed every 30s)
- Parallel order placement for NFLTRADE + NEXTTEAM (Promise.all)
- Persistent HTTP connections to Kalshi API and Groq
- No DB lookups in the hot path

### System 2 — Analyst Brain (Deep Analysis)

Runs every 5 minutes in the background. Processes the accumulated signal buffer with full context to form and update convictions.

**Responsibilities:**
- Update per-player sentiment trajectory (rising/falling/stable/volatile)
- Track team positional needs (positions filled by recent signings/trades)
- Signal stacking: combine weak signals from multiple sources into stronger conviction
- Cross-market arbitrage detection
- Negative intelligence: identify deal collapses, market overpricing
- Second-order effects: team signs WR → downgrade other WR-to-that-team signals

**Context seeding on startup:**
1. Pull all open KXNFLTRADE + KXNEXTTEAMNFL markets from Kalshi
2. Pull candlestick price history for market state understanding
3. Load persisted context from `nfl_context` table
4. If context stale (>6h), run deep-analysis LLM call to seed current landscape understanding

## Signal Sources

### Twitter/X — Tiered Polling

**Tier 1 (3-second polling):**
- @AdamSchefter (ESPN)
- @RapSheet (Ian Rapoport, NFL Network)
- @TomPelissero (NFL Network)
- @JayGlazer (Fox)

**Tier 2 (15-second polling):**
- @JosinaAnderson
- @AlbertBreer (SI/The Athletic)
- @JordanSchultz
- @MikeGarafolo (NFL Network)
- @DiannaBESPN (Dianna Russini)
- @FieldYates (ESPN)

**Tier 3 (60-second polling):**
- @NFL (official, for confirmation)
- Team-specific beat reporters for tracked players
- Aggregator accounts (cross-reference only)

**Rate budget:** 4 Tier 1 accounts x 20/min + 6 Tier 2 x 4/min + Tier 3 = ~104 req/min = ~1560/15min (within 1800 cap with margin)

## Semantic Signal Classification

The LLM maps exact insider language to confidence tiers:

| Language Pattern | Confidence | Max Buy Price |
|-----------------|------------|---------------|
| "has been traded to" | Confirmed (99%) | 95c |
| "is being traded to" | Confirmed (95%) | 90c |
| "has agreed to a deal with" | Confirmed-Signing (93%) | 90c |
| "is finalizing a deal with" | Strong Intel (85%) | 80c |
| "is expected to sign/be traded to" | Strong Intel (75%) | 70c |
| "is in serious discussions with" | Developing (50%) | 55c |
| "has drawn interest from" | Speculation (20%) | No trade |
| "could be available" / "exploring" | Speculation (5%) | No trade |

## Order Execution

### Aggressive Single-Shot Bidding

No chase strategy. One immediate bid at ceiling price.

```
Signal classified → determine max_price from confidence tier
  → Bid at min(current_ask, max_price)
  → If no ask available, bid at max_price
  → Kalshi matches at best available price
  → Bidding 95c when asks are at 55c → fills at 55c
```

### Position Sizing

- MAX_SPEND_PER_TRADE_CENTS = 2500 ($25/trade)
- Smart sizing: constant dollar risk, more contracts when cheap
- Confidence multiplier: Confirmed 1.0x, Strong Intel 0.7x, Developing 0.4x

### Parallel Execution

When a signal triggers both market types:
```typescript
await Promise.all([
  placeOrder(nfltradeTicker, "yes", maxPrice, quantity),
  placeOrder(nextteamTicker, "yes", maxPrice, quantity),
]);
```

## Cross-Market Arbitrage

Checked every market refresh cycle (30s):

**Type 1: NFLTRADE vs NEXTTEAM implied probability**
- Sum all NEXTTEAM outcomes excluding "Same team" for a player
- If sum significantly exceeds NFLTRADE price → NFLTRADE underpriced → buy
- If NFLTRADE much higher than (100 - "Same team" price) → potential overpricing

**Type 2: NEXTTEAM outcome sum > 100c**
- If outcomes sum to >105c → guaranteed overpricing exists
- Identify most overpriced outcome → sell (buy NO)

## Second-Order Intelligence

### Positional Needs Tracking

```
Team signs/trades for Position X
  → Mark Position X as "filled" for that team
  → Downgrade confidence on all other players at Position X linked to that team
  → If NEXTTEAM for other-player-to-that-team is overpriced relative to new reality → sell
```

### Signal Stacking

Multiple weak signals from independent sources compound:
```
Signal 1 (Tier 3, "interest from Chiefs"): 20% → no trade
Signal 2 (Tier 2, "visiting Chiefs"): 40% → no trade
Combined (two independent, same direction): boosted to 55% → Developing tier trade
```

### Negative Intelligence

- "Deal has fallen through" / "Talks stalled" → buy NO on NFLTRADE, sell YES positions
- Player signs extension → buy YES "Same team" NEXTTEAM, buy NO NFLTRADE
- Player cut/released → buy NO on NFLTRADE (can't be traded as free agent)

## Data Model

### nfl_signals

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| player_name | text | Player identified in signal |
| team | text (nullable) | Team mentioned (not all signals name one) |
| event_type | enum | trade, signing, cut, release, extension, rumor, cap_move |
| confidence_tier | enum | confirmed, strong_intel, developing, speculation |
| confidence_score | int (0-100) | Numeric confidence |
| source_author | text | Twitter handle |
| source_tier | int (1-3) | Source reliability tier |
| raw_text | text | Original tweet text |
| llm_classification | jsonb | Full LLM response |
| language_pattern | text | Exact phrase matched |
| context_at_signal | jsonb | Analyst brain state snapshot at signal time |
| created_at | timestamptz | |
| meta | jsonb | Extensible metadata |

### nfl_context

| Column | Type | Description |
|--------|------|-------------|
| entity_type | enum | player, team |
| entity_name | text | Player name or team name |
| context_summary | text | Analyst brain's current understanding |
| positional_needs | jsonb | For teams: {WR: "filled", CB: "high_need"} |
| linked_entities | jsonb | Connections with strength scores |
| signal_count_48h | int | Recent signal volume |
| sentiment_trajectory | enum | rising, stable, falling, volatile |
| last_deep_analysis_at | timestamptz | |
| updated_at | timestamptz | |
| meta | jsonb | |

### nfl_trades

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| signal_ids | uuid[] | All contributing signal IDs |
| primary_signal_id | uuid | The trigger signal |
| market_ticker | text | Kalshi ticker |
| market_type | enum | nfltrade, nextteam |
| side | enum | yes, no |
| action | enum | buy, sell |
| price_cents | int | Bid price |
| quantity | int | Contracts |
| confidence_tier_at_trade | enum | Tier when trade was placed |
| confidence_score_at_trade | int | Score when trade was placed |
| context_snapshot | jsonb | Full analyst brain state at trade time |
| order_id | text | Kalshi order ID |
| fill_price_cents | int (nullable) | Actual fill price |
| status | enum | placed, filled, partial, cancelled, failed |
| created_at | timestamptz | |
| meta | jsonb | |

### nfl_arbitrage_events

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| player_name | text | |
| arb_type | enum | trade_vs_nextteam, nextteam_overpriced |
| details | jsonb | The mismatch numbers |
| action_taken | text | What the bot did |
| created_at | timestamptz | |

## Dashboard (Next.js: `/nfl-fa`)

### Top Bar
- Live/paused indicator with kill switch toggle
- Balance + P&L (session / all-time)
- Active positions count + total exposure
- Last signal timestamp (staleness check)

### Main Panel — Player Cards Grid
- Player name, position, current team
- NFLTRADE price + sparkline (48h)
- Top 3 NEXTTEAM outcomes with prices
- Analyst brain sentiment indicator
- Signal count (48h) + latest signal preview
- Active positions with unrealized P&L
- Sorted by most recent signal activity

### Expanded Player View
- Full signal timeline with LLM classifications
- Context summary (analyst brain's current read)
- All NEXTTEAM outcomes with prices
- Trade history with full audit trail
- Manual override controls

### Right Sidebar — Live Signal Feed
- Streaming signal log (newest first)
- Color-coded by confidence tier
- Shows: timestamp, source, player, classification, action taken
- Arbitrage alerts highlighted

### Bottom Panel — Team View (toggle)
- NFL teams grid
- Positional needs map (filled/open)
- Cap moves + recent activity
- Players linked to team with confidence scores

### Manual Override Controls

| Control | Effect |
|---------|--------|
| Kill switch (global) | Pause all trading, keep monitoring |
| Player block/allow | Skip trading on specific players |
| Max price override (per player) | Override confidence-based ceiling |
| Confidence boost/nerf (per player) | Manually adjust one tier up/down |
| Position size multiplier | Scale all sizes 0.5x / 1x / 2x |
| Force trade | One-click manual buy/sell on any market |
| Team needs override | Manually mark positional need filled/open |

Overrides persist in `bot_status.meta` and take effect within one poll cycle.

### API Routes

```
GET  /api/nfl/status           → bot heartbeat, balance, P&L
GET  /api/nfl/players          → all tracked players with context + prices
GET  /api/nfl/players/[name]   → single player deep view
GET  /api/nfl/signals          → paginated signal feed (filterable)
GET  /api/nfl/trades           → trade history with audit chain
GET  /api/nfl/teams            → team context + positional needs
GET  /api/nfl/arbitrage        → active arbitrage opportunities
POST /api/nfl/override         → set manual overrides
POST /api/nfl/force-trade      → manually trigger a trade
```

## Deployment

- **Bot script**: `edgelord/scripts/nfl-fa-bot.ts` (Deno runtime)
- **Dashboard**: New pages in existing Next.js app (Railway auto-deploy)
- **Database**: Existing Supabase instance, new tables via migration
- **Bot ID**: `nfl-fa-bot` in `bot_status` table

### Bot Startup Sequence
1. Load environment (Kalshi keys, Groq key, Supabase, Telegram)
2. Fetch all open KXNFLTRADE + KXNEXTTEAMNFL markets
3. Build player→market ticker lookup map
4. Load persisted context from `nfl_context`
5. Load bot state from `bot_status` (tweet cursors, overrides)
6. Seed context via deep-analysis LLM if stale (>6h)
7. Start polling loops (Twitter tiers + market refresh + deep analysis)
8. Send Telegram "bot online" notification

## Learnings Applied from NBA Bot

| NBA Bot Issue | NFL Bot Solution |
|---------------|-----------------|
| YES/NO price inversion bug | Explicit `position` vs `no_position` handling from day one |
| Sequential tweet→LLM→order pipeline | Regex fast-path + parallel LLM confirmation |
| Price spike trading caused false signals | News-signal driven only, no price-spike trading |
| Single-tweet LLM analysis lacked context | Two-speed LLM: fast classification + deep contextual analysis |
| No signal audit trail | Full signal→trade chain with context snapshots |
| No manual override capability | Dashboard with per-player controls |
| Traded $70 on wrong side of YES/NO | Careful event_type classification: trade vs signing vs cut |
