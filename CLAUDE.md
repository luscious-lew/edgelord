# EdgeLord Trading Bot Project

## Quick Start for New Agents

Read these files first:
- `docs/discovery.md` - Bug history and root causes
- `docs/research.md` - Kalshi API learnings
- `docs/plan.md` - Current status and architecture
- `docs/progress.md` - What's been done

## Critical Context

### NBA Trade Bot (`scripts/nba-trade-bot-v2.ts`)
- **Trading is DISABLED** via `NBA_TRADING_DISABLED = true`
- Critical YES/NO price inversion bugs were fixed on Feb 5, 2026
- Bugs caused ~$70 loss + ~$100-150 missed profit

### Key Bug Pattern (FIXED)
Kalshi API has separate `position` and `no_position` fields. Code incorrectly assumed a single signed field.

```typescript
// WRONG
const side = p.position > 0 ? "yes" : "no";

// CORRECT
if (p.position > 0) { /* YES */ }
if (p.no_position > 0) { /* NO */ }
```

### Price Rule
YES + NO = 100¢ always. When working with NO positions, use `100 - yes_price`.

## Project Structure

```
scripts/           # Deno trading bots (excluded from Next.js build)
  nba-trade-bot-v2.ts    # NBA trades - DISABLED
  superbowl-ad-bot.ts    # Super Bowl ads - ACTIVE (YES only)
src/app/           # Next.js frontend
  api/             # API routes (positions, orders, markets, signals)
  nba-trades/      # NBA trades dashboard
  superbowl-ads/   # Super Bowl ads dashboard
supabase/          # Database migrations and edge functions
docs/              # Project documentation
```

## Deployment

- **Platform:** Railway (auto-deploys from main branch)
- **Runtime:** Next.js for web, Deno for trading scripts
