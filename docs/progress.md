# Bug Fixes Deployed (Feb 5, 2026)

## Completed

- [x] Fix `lastPrice` to use correct side (YES vs NO)
- [x] Fix `getAllPositions()` to check both `position` and `no_position` fields
- [x] Fix position sizing for NO trades
- [x] Fix daily summary P&L calculation
- [x] Add kill switch (`NBA_TRADING_DISABLED = true`)
- [x] Fix deadline date (Feb 5, not Feb 6)
- [x] UI: Color-code YES (green) / NO (red) in recent orders
- [x] Exclude scripts folder from tsconfig (fix Railway build)
- [x] Upgrade Next.js 16.0.4 → 16.0.10 (security vulnerabilities)

## Deployment

- Commit: `ba22f74`
- Deployed to Railway: Feb 5, 2026

## Remaining

- [ ] Re-enable trading after deadline passes (if desired)
- [ ] Add automated tests for YES/NO price calculations
- [ ] Add position side validation before placing orders
