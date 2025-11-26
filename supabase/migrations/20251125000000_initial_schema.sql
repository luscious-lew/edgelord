-- MARKETS: one row per Kalshi market
create table if not exists public.markets (
  id uuid primary key default gen_random_uuid(),

  venue text not null default 'kalshi',
  venue_market_ticker text not null,  -- Kalshi 'ticker'
  venue_event_ticker text,            -- 'event_ticker'
  venue_series_ticker text,           -- 'series_ticker'

  title text not null,
  category text,
  status text,                        -- open / closed / settled

  rules text,

  yes_price_last numeric(5,2),
  no_price_last numeric(5,2),

  volume numeric,
  open_interest numeric,

  start_time timestamptz,
  end_time timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique (venue, venue_market_ticker)
);

create index if not exists markets_venue_ticker_idx
  on public.markets (venue, venue_market_ticker);

-- MARKET_QUOTES: snapshots of orderbooks over time
create table if not exists public.market_quotes (
  id bigserial primary key,
  market_id uuid references public.markets(id) on delete cascade,
  ts timestamptz not null default now(),

  yes_best_bid numeric(5,2),
  yes_best_bid_qty numeric,
  no_best_bid numeric(5,2),
  no_best_bid_qty numeric,

  yes_price_last numeric(5,2),
  no_price_last numeric(5,2),

  orderbook_raw jsonb
);

create index if not exists market_quotes_market_ts_idx
  on public.market_quotes (market_id, ts desc);

-- SIGNALS: model-based edge calculations (to be used later)
create table if not exists public.signals (
  id bigserial primary key,
  market_id uuid references public.markets(id) on delete cascade,
  ts timestamptz not null default now(),
  signal_type text not null default 'model_edge',
  p_market numeric(6,4),
  p_model numeric(6,4),
  edge numeric(7,4),
  meta jsonb
);

create index if not exists signals_market_ts_idx
  on public.signals (market_id, ts desc);
