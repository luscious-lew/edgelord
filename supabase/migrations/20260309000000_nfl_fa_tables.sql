-- NFL Free Agency Bot Tables
-- Signal classification, context tracking, trade execution, and arbitrage detection

-- ============================================================
-- 1. nfl_signals — Signal classifications from tweets
-- ============================================================

create table if not exists public.nfl_signals (
  id uuid default gen_random_uuid() primary key,
  player_name text not null,
  team text,                                    -- nullable: not all signals name a team
  event_type text not null check (event_type in ('trade','signing','cut','release','extension','rumor','cap_move')),
  confidence_tier text not null check (confidence_tier in ('confirmed','strong_intel','developing','speculation')),
  confidence_score integer not null check (confidence_score >= 0 and confidence_score <= 100),
  source_author text not null,                  -- twitter handle
  source_tier integer not null check (source_tier >= 1 and source_tier <= 3),
  raw_text text not null,                       -- original tweet text
  llm_classification jsonb,                     -- full LLM response
  language_pattern text,                        -- exact phrase matched
  context_at_signal jsonb,                      -- analyst brain state snapshot
  created_at timestamptz default now(),
  meta jsonb default '{}'::jsonb
);

create index if not exists idx_nfl_signals_player on public.nfl_signals (player_name);
create index if not exists idx_nfl_signals_created on public.nfl_signals (created_at desc);
create index if not exists idx_nfl_signals_confidence on public.nfl_signals (confidence_tier);

alter table public.nfl_signals enable row level security;

drop policy if exists "Allow public read access to nfl_signals" on public.nfl_signals;
create policy "Allow public read access to nfl_signals"
  on public.nfl_signals
  for select
  using (true);

-- ============================================================
-- 2. nfl_context — Analyst brain context per player/team
-- ============================================================

create table if not exists public.nfl_context (
  id uuid default gen_random_uuid() primary key,
  entity_type text not null check (entity_type in ('player','team')),
  entity_name text not null,
  context_summary text,
  positional_needs jsonb default '{}'::jsonb,    -- for teams: {WR: "filled", CB: "high_need"}
  linked_entities jsonb default '{}'::jsonb,     -- connections with strength scores
  signal_count_48h integer default 0,
  sentiment_trajectory text default 'stable' check (sentiment_trajectory in ('rising','stable','falling','volatile')),
  last_deep_analysis_at timestamptz,
  updated_at timestamptz default now(),
  meta jsonb default '{}'::jsonb,
  unique (entity_type, entity_name)
);

create index if not exists idx_nfl_context_entity on public.nfl_context (entity_type, entity_name);

alter table public.nfl_context enable row level security;

drop policy if exists "Allow public read access to nfl_context" on public.nfl_context;
create policy "Allow public read access to nfl_context"
  on public.nfl_context
  for select
  using (true);

-- ============================================================
-- 3. nfl_trades — Trade execution with full audit chain
-- ============================================================

create table if not exists public.nfl_trades (
  id uuid default gen_random_uuid() primary key,
  signal_ids uuid[] default '{}',               -- all contributing signal IDs
  primary_signal_id uuid references public.nfl_signals(id),
  market_ticker text not null,
  market_type text not null check (market_type in ('nfltrade','nextteam')),
  side text not null check (side in ('yes','no')),
  action text not null check (action in ('buy','sell')),
  price_cents integer not null,                 -- bid price in cents
  quantity integer not null,                    -- number of contracts
  confidence_tier_at_trade text,
  confidence_score_at_trade integer,
  context_snapshot jsonb,                       -- full analyst brain state at trade time
  order_id text,                                -- Kalshi order ID
  fill_price_cents integer,                     -- actual fill price
  status text default 'placed' check (status in ('placed','filled','partial','cancelled','failed')),
  created_at timestamptz default now(),
  meta jsonb default '{}'::jsonb
);

create index if not exists idx_nfl_trades_ticker on public.nfl_trades (market_ticker);
create index if not exists idx_nfl_trades_created on public.nfl_trades (created_at desc);
create index if not exists idx_nfl_trades_signal on public.nfl_trades (primary_signal_id);

alter table public.nfl_trades enable row level security;

drop policy if exists "Allow public read access to nfl_trades" on public.nfl_trades;
create policy "Allow public read access to nfl_trades"
  on public.nfl_trades
  for select
  using (true);

-- ============================================================
-- 4. nfl_arbitrage_events — Cross-market arbitrage detections
-- ============================================================

create table if not exists public.nfl_arbitrage_events (
  id uuid default gen_random_uuid() primary key,
  player_name text not null,
  arb_type text not null check (arb_type in ('trade_vs_nextteam','nextteam_overpriced')),
  details jsonb not null,
  action_taken text,
  created_at timestamptz default now()
);

create index if not exists idx_nfl_arb_events_created on public.nfl_arbitrage_events (created_at desc);

alter table public.nfl_arbitrage_events enable row level security;

drop policy if exists "Allow public read access to nfl_arbitrage_events" on public.nfl_arbitrage_events;
create policy "Allow public read access to nfl_arbitrage_events"
  on public.nfl_arbitrage_events
  for select
  using (true);

-- ============================================================
-- Add tables to Realtime publication (not nfl_arbitrage_events)
-- ============================================================

do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.nfl_signals';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.nfl_context';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.nfl_trades';
  exception when duplicate_object then null;
  end;
end $$;
