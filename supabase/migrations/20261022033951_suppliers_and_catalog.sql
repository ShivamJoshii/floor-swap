-- Suppliers: shared across stores (store_id null) or private to one store.
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website text,
  region text,
  notes text,
  store_id uuid references public.stores(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists suppliers_name_scope_idx on public.suppliers (lower(name), coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Shared product information keyed by supplier + SKU. No prices, no stock.
create table if not exists public.supplier_products (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  sku text not null,
  name text not null,
  type text not null default 'tile' check (type in ('plank','tile','carpet','other')),
  length_in numeric(8,2),
  width_in numeric(8,2),
  thickness_mm numeric(6,2),
  finish text,
  colour_family text,
  collection text,
  notes text,
  swatch_path text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (supplier_id, sku)
);
create index if not exists supplier_products_name_idx on public.supplier_products (lower(name));

alter table public.products
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null,
  add column if not exists supplier_product_id uuid references public.supplier_products(id) on delete set null,
  add column if not exists finish text,
  add column if not exists colour_family text,
  add column if not exists collection text;

alter table public.suppliers enable row level security;
alter table public.supplier_products enable row level security;

create policy "suppliers readable" on public.suppliers for select to authenticated using (store_id is null or public.is_member(store_id));
create policy "members add suppliers" on public.suppliers for insert to authenticated with check (store_id is null or public.is_member(store_id));
create policy "edit own suppliers" on public.suppliers for update to authenticated using (created_by = auth.uid() or public.is_platform_admin() or (store_id is not null and public.is_owner(store_id)));
create policy "delete own suppliers" on public.suppliers for delete to authenticated using (created_by = auth.uid() or public.is_platform_admin());

create policy "catalog readable" on public.supplier_products for select to authenticated using (true);
create policy "members add to catalog" on public.supplier_products for insert to authenticated with check (auth.uid() is not null);
create policy "edit own catalog rows" on public.supplier_products for update to authenticated using (created_by = auth.uid() or public.is_platform_admin());
create policy "delete own catalog rows" on public.supplier_products for delete to authenticated using (created_by = auth.uid() or public.is_platform_admin());

-- Shared swatch bucket for the supplier catalog: any signed-in user reads, uploaders write under their own user id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('catalog', 'catalog', false, 31457280, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy "catalog swatches readable" on storage.objects for select to authenticated using (bucket_id = 'catalog');
create policy "catalog swatches upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'catalog' and split_part(name, '/', 1) = auth.uid()::text);

-- Generation defaults: render 1 option unless staff ask for more.
insert into public.app_settings (key, value) values ('default_images', '1') on conflict (key) do nothing;
