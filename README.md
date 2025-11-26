# EdgeLord

EdgeLord is a Supabase + Next.js project that ingests Kalshi markets and orderbooks, stores them for analysis, and provides a web UI for exploring prediction-market data and (eventually) edge signals.

## Quickstart

1.  **Install dependencies:**

    ```bash
    npm install
    ```

2.  **Apply database migrations** to the linked Supabase project:

    ```bash
    npx supabase db push
    ```

3.  **Deploy edge functions:**

    ```bash
    npx supabase functions deploy ingest_markets
    npx supabase functions deploy ingest_orderbooks
    ```

4.  **Set environment variables:**

    In Supabase (Project Settings → API / Functions):
    *   `SUPABASE_URL`
    *   `SUPABASE_SERVICE_ROLE_KEY`
    *   `KALSHI_API_KEY` (if required)

    In `.env.local` for Next.js:
    *   `NEXT_PUBLIC_SUPABASE_URL`
    *   `NEXT_PUBLIC_SUPABASE_ANON_KEY`

5.  **Set up real-time data ingestion:**

    **Option A: Real-time WebSocket Connection (Recommended for live prices)**
    
    Kalshi provides a WebSocket API for real-time market updates. Deploy the WebSocket stream function:
    
    ```bash
    npx supabase functions deploy kalshi-websocket-stream
    ```
    
    **Important:** Edge Functions have execution time limits. For a persistent WebSocket connection, consider:
    - Running the WebSocket client as a separate service (Railway, Render, etc.)
    - Or using Supabase's background workers when available
    
    The WebSocket function will:
    - Connect to Kalshi's WebSocket API (`wss://api.elections.kalshi.com/trade-api/ws/v2`)
    - Stream real-time price updates directly to your Supabase database
    - Your UI will automatically update via Supabase Realtime subscriptions
    
    **Option B: Scheduled Polling (Fallback)**
    
    If WebSocket isn't available, use cron jobs for periodic updates:
    
    1. Go to: https://supabase.com/dashboard/project/hquevhjfozjqgciieqsl
    2. Navigate to **Database** → **Cron Jobs**
    3. Click **New Cron Job**
    
    **For `ingest_markets`** (runs every 15 minutes):
    - Name: `ingest_markets_every_15min`
    - Schedule: `*/15 * * * *`
    - Function URL: `https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_markets`
    - HTTP Method: `POST`
    - Headers: `Authorization: Bearer [YOUR_SERVICE_ROLE_KEY]`
    - Body: `{}`
    
    **For `ingest_orderbooks`** (runs every 5 minutes):
    - Name: `ingest_orderbooks_every_5min`
    - Schedule: `*/5 * * * *`
    - Function URL: `https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_orderbooks`
    - HTTP Method: `POST`
    - Headers: `Authorization: Bearer [YOUR_SERVICE_ROLE_KEY]`
    - Body: `{}`
    
    **Test manually:**
    ```bash
    # Set your service role key first
    export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
    ./scripts/test-ingest.sh
    ```

6.  **Run the dev server:**

    ```bash
    npm run dev
    ```
