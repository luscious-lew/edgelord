# Kalshi API - Key Learnings

## Position Data Structure

```typescript
// Kalshi API response for market_positions
{
  ticker: string,
  position: number,      // YES contracts owned (0 if none)
  no_position: number,   // NO contracts owned (0 if none)
}
```

**Important:** These are two separate fields, NOT a single signed field.

## Price Conversion

- YES + NO = 100¢ always (binary market)
- When holding NO: display price = `100 - yes_price`
- When selling NO: use `100 - yes_price` for limit price

## Correct Position Detection

```typescript
// WRONG - assumes single signed field
const side = p.position > 0 ? "yes" : "no";

// CORRECT - check both fields
if (p.position && p.position > 0) {
  // User holds YES contracts
}
if (p.no_position && p.no_position > 0) {
  // User holds NO contracts
}
```

## API Endpoints Used

- `GET /trade-api/v2/portfolio/positions` - Get all positions
- `GET /trade-api/v2/portfolio/fills` - Get trade history
- `POST /trade-api/v2/portfolio/orders` - Place orders
- `GET /trade-api/v2/markets/{ticker}` - Get market data
