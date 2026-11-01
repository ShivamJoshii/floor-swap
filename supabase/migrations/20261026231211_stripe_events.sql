create table if not exists public.stripe_events (id text primary key, type text, received_at timestamptz not null default now());
alter table public.stripe_events enable row level security;
