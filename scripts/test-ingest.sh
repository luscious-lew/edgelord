#!/bin/bash
# Test script for ingesting Kalshi markets
# Usage: ./scripts/test-ingest.sh

PROJECT_REF="hquevhjfozjqgciieqsl"
SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-your-service-role-key-here}"

if [ "$SERVICE_ROLE_KEY" = "your-service-role-key-here" ]; then
  echo "Error: Set SUPABASE_SERVICE_ROLE_KEY environment variable"
  echo "Get it from: Supabase Dashboard → Project Settings → API → service_role key"
  exit 1
fi

echo "Testing ingest_markets..."
curl -X POST "https://${PROJECT_REF}.supabase.co/functions/v1/ingest_markets" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .

echo ""
echo "Testing ingest_orderbooks..."
curl -X POST "https://${PROJECT_REF}.supabase.co/functions/v1/ingest_orderbooks" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .

