-- Builder sheets: product info + a styled room photo per product, sent to builders/contractors
-- who have no room of their own to render on.

-- One reusable "showcase" room photo per product (stored in the renders bucket under <store>/showcase/).
alter table public.products
  add column if not exists showcase_path text,
  add column if not exists showcase_status text check (showcase_status in ('running', 'done', 'failed')),
  add column if not exists showcase_error text,
  add column if not exists showcase_updated_at timestamptz;

create table if not exists public.builder_sheets (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  token text not null unique,
  builder_name text,
  builder_company text,
  builder_phone text,
  builder_email text,
  note text,
  show_prices boolean not null default false,
  product_ids uuid[] not null default '{}',
  pdf_path text,
  views integer not null default 0,
  last_viewed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists builder_sheets_store_idx on public.builder_sheets(store_id, created_at desc);
alter table public.builder_sheets enable row level security;

create policy "members read builder sheets" on public.builder_sheets for select to authenticated using (public.is_member(store_id));
create policy "members add builder sheets" on public.builder_sheets for insert to authenticated with check (public.is_member(store_id));
create policy "members edit builder sheets" on public.builder_sheets for update to authenticated using (public.is_member(store_id)) with check (public.is_member(store_id));
create policy "members delete builder sheets" on public.builder_sheets for delete to authenticated using (public.is_member(store_id));
-- Builders never query this table: the public page goes through the builder-sheet edge function (service role, by token).
