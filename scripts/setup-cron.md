# Setting Up Automated Data Ingestion

To keep your Kalshi data fresh, you need to schedule the `ingest_markets` and `ingest_orderbooks` functions to run automatically.

## Option 1: Using Supabase Dashboard (Recommended)

1. Go to your Supabase Dashboard: https://supabase.com/dashboard/project/hquevhjfozjqgciieqsl
2. Navigate to **Database** → **Cron Jobs**
3. Click **New Cron Job**

### For `ingest_markets`:
- **Name**: `ingest_markets_every_15min`
- **Schedule**: `*/15 * * * *` (every 15 minutes)
- **Function URL**: `https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_markets`
- **HTTP Method**: `POST`
- **Headers**: 
  - `Authorization: Bearer [YOUR_SERVICE_ROLE_KEY]`
  - `Content-Type: application/json`
- **Body**: `{}`

### For `ingest_orderbooks`:
- **Name**: `ingest_orderbooks_every_5min`
- **Schedule**: `*/5 * * * *` (every 5 minutes)
- **Function URL**: `https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_orderbooks`
- **HTTP Method**: `POST`
- **Headers**: 
  - `Authorization: Bearer [YOUR_SERVICE_ROLE_KEY]`
  - `Content-Type: application/json`
- **Body**: `{}`

## Option 2: Using pg_cron (Advanced)

If you prefer to use pg_cron directly, you'll need to:

1. Enable the `pg_net` extension
2. Create SQL functions that call your edge functions via HTTP
3. Schedule them using `cron.schedule()`

See the migration file for details.

## Testing Manually

To test the functions manually:

```bash
# Test ingest_markets
curl -X POST https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_markets \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'

# Test ingest_orderbooks
curl -X POST https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_orderbooks \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Monitoring

Check your cron jobs in the Supabase Dashboard under **Database** → **Cron Jobs** to see execution history and logs.

