# NBA Trade Bot - Bug Discovery (Feb 5, 2026)

## Critical YES/NO Price Inversion Bugs Found

1. **`lastPrice` calculation** - Used YES price for NO positions when selling
2. **`getAllPositions()`** - Incorrectly detected position side (assumed `position > 0` = YES, but Kalshi has separate `position` and `no_position` fields)
3. **Position sizing** - Used YES price when calculating size for NO trades
4. **Daily summary P&L** - Calculated unrealized P&L using wrong price for NO positions

## Root Cause

Kalshi API returns `position` (YES contracts) and `no_position` (NO contracts) as separate fields. Our code assumed a single `position` field where positive = YES and negative = NO.

## Financial Impact

- ~$70 actual loss
- ~$100-150 missed profit (sold Ja Morant NO at ~77¢ instead of 95-100¢)

## Affected Code Locations

All in `scripts/nba-trade-bot-v2.ts`:
- `lastPrice` calculation (~line 1975)
- `getAllPositions()` function (~line 2147)
- Position sizing (~line 2555)
- Daily summary (~line 348)
