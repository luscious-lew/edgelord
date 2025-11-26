-- Enable pg_cron extension for scheduling
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA cron TO postgres;

-- Note: Supabase cron jobs are best configured via the Dashboard
-- Go to: Database → Cron Jobs → New Cron Job
-- 
-- For ingest_markets:
--   Schedule: */15 * * * * (every 15 minutes)
--   Function URL: https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_markets
--   Method: POST
--   Headers: Authorization: Bearer [service_role_key]
--
-- For ingest_orderbooks:
--   Schedule: */5 * * * * (every 5 minutes)  
--   Function URL: https://hquevhjfozjqgciieqsl.supabase.co/functions/v1/ingest_orderbooks
--   Method: POST
--   Headers: Authorization: Bearer [service_role_key]
--
-- View existing cron jobs:
-- SELECT * FROM cron.job;

