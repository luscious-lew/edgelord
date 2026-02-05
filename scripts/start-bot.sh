#!/bin/bash
cd /Users/lewisclements/Documents/Work/EdgeLord/edgelord

# Load env vars from .env.local
set -a
source .env.local
set +a

# Run the bot
exec deno run --allow-net --allow-env scripts/nba-trade-bot-v2.ts
