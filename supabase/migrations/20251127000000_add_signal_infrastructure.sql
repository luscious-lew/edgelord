-- SIGNAL SOURCES: raw ingested content from external feeds
-- Stores news articles, tweets, Reddit posts, and other external sources
create table if not exists public.signal_sources (
  id bigserial primary key,
  source_type text not null,              -- news / twitter / reddit / webhook / etc
  source_url text,                         -- unique nullable URL to original source
  title text,
  content text,                            -- full text content of the source
  author text,                             -- author/account name
  published_at timestamptz,                -- when the source was originally published
  ingested_at timestamptz not null default now(),  -- when we ingested it
  raw_data jsonb,                          -- original API response/metadata
  created_at timestamptz not null default now()
);

create index if not exists signal_sources_source_type_published_idx
  on public.signal_sources (source_type, published_at desc);

create index if not exists signal_sources_published_idx
  on public.signal_sources (published_at desc);

create unique index if not exists signal_sources_source_url_unique_idx
  on public.signal_sources (source_url)
  where source_url is not null;

-- MATCHING: links sources to markets with scoring + metadata
-- Tracks which sources are relevant to which markets and how they match
create table if not exists public.signal_source_market_matches (
  id bigserial primary key,
  signal_source_id bigint not null references public.signal_sources(id) on delete cascade,
  market_id uuid not null references public.markets(id) on delete cascade,
  match_score numeric(6,4) not null,      -- 0.0000 to 1.0000 confidence score
  match_type text not null,                -- keyword / entity / semantic
  matched_entities jsonb,                  -- extracted entities that matched (people, places, events)
  created_at timestamptz not null default now(),
  
  -- Prevent duplicate matches
  unique (signal_source_id, market_id)
);

create index if not exists signal_source_market_matches_source_idx
  on public.signal_source_market_matches (signal_source_id, match_score desc);

create index if not exists signal_source_market_matches_market_idx
  on public.signal_source_market_matches (market_id);

-- SENTIMENTS: per-source/per-market sentiment analysis results
-- Stores sentiment analysis for each source-market pair
create table if not exists public.signal_sentiments (
  id bigserial primary key,
  signal_source_id bigint not null references public.signal_sources(id) on delete cascade,
  market_id uuid not null references public.markets(id) on delete cascade,
  sentiment_label text not null,          -- positive / negative / neutral
  sentiment_score numeric(3,2) not null,  -- -1.00 to 1.00 (negative to positive)
  bullish_for_yes boolean,                -- true if sentiment favors YES outcome
  key_phrases jsonb,                      -- extracted phrases that drive sentiment
  analyzed_at timestamptz not null default now(),
  
  -- One sentiment analysis per source-market pair
  unique (signal_source_id, market_id)
);

create index if not exists signal_sentiments_market_idx
  on public.signal_sentiments (market_id, analyzed_at desc);

create index if not exists signal_sentiments_source_idx
  on public.signal_sentiments (signal_source_id, analyzed_at desc);

-- ENHANCE SIGNALS: attach source + scoring metadata
-- Extends the existing signals table with sentiment and signal generation data
alter table public.signals
  add column if not exists signal_source_id bigint references public.signal_sources(id) on delete set null,
  add column if not exists sentiment_label text,              -- positive / negative / neutral
  add column if not exists sentiment_score numeric(3,2),     -- -1.00 to 1.00
  add column if not exists signal_strength numeric(6,4),      -- 0.0000 to 1.0000 overall signal confidence
  add column if not exists recommended_action text,          -- buy_yes / buy_no / hold
  add column if not exists bullish_for_yes boolean,          -- true if sentiment favors YES
  add column if not exists expires_at timestamptz;           -- when signal becomes stale

create index if not exists signals_source_ts_idx
  on public.signals (signal_source_id, ts desc);

create index if not exists signals_expires_idx
  on public.signals (expires_at);

-- Enable RLS + public read access for new tables
alter table public.signal_sources enable row level security;
alter table public.signal_source_market_matches enable row level security;
alter table public.signal_sentiments enable row level security;

drop policy if exists "Allow public read access to signal_sources" on public.signal_sources;
create policy "Allow public read access to signal_sources"
  on public.signal_sources
  for select
  using (true);

drop policy if exists "Allow public read access to signal_source_market_matches" on public.signal_source_market_matches;
create policy "Allow public read access to signal_source_market_matches"
  on public.signal_source_market_matches
  for select
  using (true);

drop policy if exists "Allow public read access to signal_sentiments" on public.signal_sentiments;
create policy "Allow public read access to signal_sentiments"
  on public.signal_sentiments
  for select
  using (true);

-- Add to Realtime publication (ignore if already added)
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.signals';
  exception
    when duplicate_object then null;
  end;

  begin
    execute 'alter publication supabase_realtime add table public.signal_sentiments';
  exception
    when duplicate_object then null;
  end;
end $$;
