# NBA Trade Bot - Status & Plan

## Current Status

### Kill Switch: ENABLED
`NBA_TRADING_DISABLED = true` in `scripts/nba-trade-bot-v2.ts`

### NBA Trade Deadline
Feb 5, 2026 @ 3pm ET (8pm UTC) - `2026-02-05T20:00:00Z`

## To Re-enable Trading

1. Set `NBA_TRADING_DISABLED = false` in `scripts/nba-trade-bot-v2.ts`
2. Test with small position first
3. Verify correct YES/NO pricing in logs before scaling up

## Active Bots

| Bot | File | Status | Notes |
|-----|------|--------|-------|
| NBA Trade Bot | `scripts/nba-trade-bot-v2.ts` | DISABLED | Kill switch active |
| Super Bowl Ad Bot | `scripts/superbowl-ad-bot.ts` | ACTIVE | Only YES buys, no sell logic |

## Architecture

- **Frontend:** Next.js app at `src/app/`
- **API Routes:** `src/app/api/` (positions, orders, markets, signals)
- **Trading Bots:** `scripts/` (Deno runtime)
- **Database:** Supabase (migrations in `supabase/migrations/`)
- **Deployment:** Railway (auto-deploys from main branch)
