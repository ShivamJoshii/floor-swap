-- Builder sheets v2: rooms with several products ("combos"), one AI photo per combo.
-- A combo = room type + which product goes in which spot (floor, backsplash, shower, feature wall).
-- Each distinct combo is rendered once per store and reused (combo_key is the cache key).

create table if not exists public.room_renders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  room_type text not null,
  spots jsonb not null,               -- {"floor": "<product id>", "backsplash": "<product id>", ...}
  combo_key text not null,            -- room_type|spot=id|spot=id (sorted)
  path text,                          -- renders bucket: <store>/rooms/<id>.<ext>
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  error text,
  model text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, combo_key)
);
alter table public.room_renders enable row level security;
create policy "members read room renders" on public.room_renders for select to authenticated using (public.is_member(store_id));
-- Writes happen in the room-render edge function (service role).

-- The sheet keeps its rooms in order: [{label, room_type, spots, render_id}]
alter table public.builder_sheets add column if not exists rooms jsonb not null default '[]';
