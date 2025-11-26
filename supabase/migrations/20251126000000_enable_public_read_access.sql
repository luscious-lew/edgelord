-- Enable Row Level Security on markets table (if it exists)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'markets') THEN
    ALTER TABLE public.markets ENABLE ROW LEVEL SECURITY;
    
    -- Drop policy if it exists, then create it
    DROP POLICY IF EXISTS "Allow public read access to markets" ON public.markets;
    CREATE POLICY "Allow public read access to markets"
      ON public.markets
      FOR SELECT
      USING (true);
  END IF;
END $$;

-- Enable Row Level Security on market_quotes table (if it exists)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'market_quotes') THEN
    ALTER TABLE public.market_quotes ENABLE ROW LEVEL SECURITY;
    
    DROP POLICY IF EXISTS "Allow public read access to market_quotes" ON public.market_quotes;
    CREATE POLICY "Allow public read access to market_quotes"
      ON public.market_quotes
      FOR SELECT
      USING (true);
  END IF;
END $$;

-- Enable Row Level Security on signals table (if it exists)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signals') THEN
    ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
    
    DROP POLICY IF EXISTS "Allow public read access to signals" ON public.signals;
    CREATE POLICY "Allow public read access to signals"
      ON public.signals
      FOR SELECT
      USING (true);
  END IF;
END $$;

