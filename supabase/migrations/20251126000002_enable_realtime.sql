-- Enable Realtime for markets table so clients can subscribe to changes
ALTER PUBLICATION supabase_realtime ADD TABLE public.markets;

-- Enable Realtime for market_quotes table
ALTER PUBLICATION supabase_realtime ADD TABLE public.market_quotes;

