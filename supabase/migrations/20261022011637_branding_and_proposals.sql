alter table public.stores
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists address text,
  add column if not exists website text,
  add column if not exists tagline text,
  add column if not exists cta_text text,
  add column if not exists brand_color text,
  add column if not exists logo_path text;

create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  lead_name text,
  lead_phone text,
  room_path text,
  items jsonb not null default '[]'::jsonb,
  pdf_path text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists proposals_store_idx on public.proposals(store_id, created_at desc);
alter table public.proposals enable row level security;
create policy "members read proposals" on public.proposals for select to authenticated using (public.is_member(store_id));
create policy "members add proposals" on public.proposals for insert to authenticated with check (public.is_member(store_id));
create policy "members delete proposals" on public.proposals for delete to authenticated using (public.is_member(store_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('proposals', 'proposals', false, 52428800, array['application/pdf']),
  ('brand', 'brand', false, 5242880, array['image/jpeg','image/png','image/webp','image/svg+xml'])
on conflict (id) do nothing;

create policy "members read proposals files" on storage.objects for select to authenticated
  using (bucket_id = 'proposals' and public.is_member(public.path_store(name)));
create policy "members write proposals files" on storage.objects for insert to authenticated
  with check (bucket_id = 'proposals' and public.is_member(public.path_store(name)));
create policy "members read brand" on storage.objects for select to authenticated
  using (bucket_id = 'brand' and public.is_member(public.path_store(name)));
create policy "owners write brand" on storage.objects for insert to authenticated
  with check (bucket_id = 'brand' and public.is_owner(public.path_store(name)));
create policy "owners update brand" on storage.objects for update to authenticated
  using (bucket_id = 'brand' and public.is_owner(public.path_store(name)));

-- Swatch masters can be larger now (full-res scans).
update storage.buckets set file_size_limit = 31457280 where id = 'swatches';

-- Seed F&M contact details from the catalogue.
update public.stores set phone = coalesce(phone, '780-803-8332'), email = coalesce(email, 'info@floorandmorecanada.com'),
  address = coalesce(address, '7027 Roper Road NW, Edmonton, AB'), cta_text = coalesce(cta_text, 'Book your free in-home measure')
  where id = '5d148dc0-bf36-4301-a4c2-3d5fbef12458';
