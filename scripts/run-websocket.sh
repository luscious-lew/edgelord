#!/bin/bash
# Run the WebSocket service locally or deploy to Railway/Render

# Set your environment variables
export SUPABASE_URL="https://hquevhjfozjqgciieqsl.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
export KALSHI_API_KEY_ID="your-kalshi-api-key-id"
export KALSHI_PRIVATE_KEY="$(cat /path/to/your/kalshi-key-pkcs8.pem)"

# Run the service
deno run --allow-net --allow-env scripts/websocket-service.ts

