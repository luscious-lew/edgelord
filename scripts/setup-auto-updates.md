# Setting Up Automatic Data Updates

## Current Status

✅ **UI is real-time ready** - Your UI will automatically update when prices change in the database
❌ **Data source is manual** - Prices only update when you manually call `ingest_markets`

## To Get Live Updates

You have two options:

### Option 1: Cron Jobs (Easiest - Recommended)

Set up scheduled jobs to automatically fetch data every few minutes:

1. Go to: https://supabase.com/dashboard/project/hquevhjfozjqgciieqsl
2. Navigate to **Database** → **Cron Jobs**
3. Click **New Cron Job**

**For `ingest_markets`** (updates market list and prices every 5 minutes):
- **Name**: `ingest_markets_auto`
- **Schedule**: `*/5 * * * *` (every 5 minutes)
- **Function URL**: `https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_markets`
- **HTTP Method**: `POST`
- **Headers**: (leave empty - function doesn't require auth)
- **Body**: `{}`

**For `ingest_orderbooks`** (updates orderbook data every 2 minutes):
- **Name**: `ingest_orderbooks_auto`
- **Schedule**: `*/2 * * * *` (every 2 minutes)
- **Function URL**: `https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_orderbooks`
- **HTTP Method**: `POST`
- **Headers**: (leave empty)
- **Body**: `{}`

Once set up, your UI will automatically update every 2-5 minutes as new data comes in!

### Option 2: WebSocket (True Real-Time)

For true real-time updates (sub-second), deploy the WebSocket function. However, Edge Functions have time limits, so this works best as a separate service.

## How It Works

1. Cron job calls `ingest_markets` → Updates database
2. Database change triggers Supabase Realtime
3. Your UI automatically updates (no refresh needed!)

You'll see the "🔴 Live updates enabled" indicator, and prices will update automatically.

