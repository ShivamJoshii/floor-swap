-- Floor Swap: stores, products, renders, prepaid credits.
create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value) values
  ('model', '"fal-ai/nano-banana-2/edit"'),
  ('images_per_generation', '3'),
  ('credits_per_generation', '1'),
  ('trial_credits', '5'),
  ('provider_cost_cents_per_image', '4')
on conflict (key) do nothing;

create table if not exists public.credit_packs (
  id text primary key,
  name text not null,
  credits int not null check (credits > 0),
  price_cents int not null check (price_cents >= 0),
  currency text not null default 'CAD',
  active boolean not null default true,
  sort int not null default 0
);
insert into public.credit_packs (id, name, credits, price_cents, sort) values
  ('starter', 'Starter', 50, 2000, 1),
  ('growth',  'Growth', 200, 7000, 2),
  ('pro',     'Pro',    600, 18000, 3)
on conflict (id) do nothing;

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.store_members (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);
create index if not exists store_members_user_idx on public.store_members(user_id);

create table if not exists public.store_invites (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  email text not null,
  role text not null default 'staff' check (role in ('owner','staff')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (store_id, email)
);
create index if not exists store_invites_email_idx on public.store_invites(lower(email));

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  sku text,
  type text not null default 'plank' check (type in ('plank','tile','carpet','other')),
  length_in numeric(8,2),
  width_in numeric(8,2),
  price_per_sqft numeric(10,2),
  swatch_path text not null,
  notes text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists products_store_idx on public.products(store_id, active);

create table if not exists public.renders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  room_path text not null,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  model text,
  prompt text,
  options jsonb not null default '{}'::jsonb,
  outputs jsonb not null default '[]'::jsonb,
  error text,
  credits_charged int not null default 0,
  provider_cost_cents numeric(10,2),
  lead_name text,
  lead_phone text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists renders_store_idx on public.renders(store_id, created_at desc);

create table if not exists public.credit_ledger (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  delta int not null,
  reason text not null check (reason in ('trial','purchase','generation','refund','adjustment')),
  render_id uuid references public.renders(id) on delete set null,
  pack_id text references public.credit_packs(id),
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_store_idx on public.credit_ledger(store_id, created_at desc);

create or replace function public.is_member(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.store_members where store_id = p_store and user_id = auth.uid());
$$;

create or replace function public.is_owner(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.store_members where store_id = p_store and user_id = auth.uid() and role = 'owner');
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.path_store(p_name text)
returns uuid language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

create or replace function public.store_balance(p_store uuid)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(sum(delta), 0)::int from public.credit_ledger where store_id = p_store;
$$;

create or replace function public.create_store(p_name text, p_city text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_trial int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'store name required'; end if;
  insert into public.stores (name, city, created_by) values (trim(p_name), nullif(trim(p_city), ''), auth.uid()) returning id into v_store;
  insert into public.store_members (store_id, user_id, role) values (v_store, auth.uid(), 'owner');
  select coalesce((value)::int, 0) into v_trial from public.app_settings where key = 'trial_credits';
  if v_trial > 0 then
    insert into public.credit_ledger (store_id, delta, reason, note, created_by) values (v_store, v_trial, 'trial', 'welcome credits', auth.uid());
  end if;
  return v_store;
end;
$$;

create or replace function public.accept_invites()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_count int := 0;
  r record;
begin
  select email into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  for r in select * from public.store_invites where lower(email) = lower(v_email) and accepted_at is null loop
    insert into public.store_members (store_id, user_id, role) values (r.store_id, auth.uid(), r.role) on conflict do nothing;
    update public.store_invites set accepted_at = now() where id = r.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.consume_credits(p_store uuid, p_amount int, p_render uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_balance int;
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if auth.role() <> 'service_role' and not public.is_member(p_store) then raise exception 'not a member'; end if;
  perform 1 from public.stores where id = p_store for update;
  select coalesce(sum(delta), 0) into v_balance from public.credit_ledger where store_id = p_store;
  if v_balance < p_amount then raise exception 'insufficient credits (balance %)', v_balance using errcode = 'P0001';
  end if;
  insert into public.credit_ledger (store_id, delta, reason, render_id, created_by)
    values (p_store, -p_amount, 'generation', p_render, auth.uid());
  return v_balance - p_amount;
end;
$$;

create or replace function public.grant_credits(p_store uuid, p_amount int, p_reason text default 'purchase', p_pack text default null, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' and not public.is_platform_admin() then raise exception 'admin only'; end if;
  if p_reason not in ('purchase','adjustment','trial','refund') then raise exception 'bad reason'; end if;
  insert into public.credit_ledger (store_id, delta, reason, pack_id, note, created_by)
    values (p_store, p_amount, p_reason, p_pack, p_note, auth.uid());
  return public.store_balance(p_store);
end;
$$;

create or replace function public.admin_stores()
returns table (id uuid, name text, city text, created_at timestamptz, balance int, members int, renders int, last_render timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.city, s.created_at,
    public.store_balance(s.id) as balance,
    (select count(*) from public.store_members m where m.store_id = s.id)::int as members,
    (select count(*) from public.renders r where r.store_id = s.id)::int as renders,
    (select max(r.created_at) from public.renders r where r.store_id = s.id) as last_render
  from public.stores s
  where public.is_platform_admin()
  order by s.created_at desc;
$$;

alter table public.app_settings enable row level security;
alter table public.credit_packs enable row level security;
alter table public.platform_admins enable row level security;
alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.store_invites enable row level security;
alter table public.products enable row level security;
alter table public.renders enable row level security;
alter table public.credit_ledger enable row level security;

create policy "packs readable" on public.credit_packs for select to authenticated using (active);
create policy "admins see admins" on public.platform_admins for select to authenticated using (user_id = auth.uid());
create policy "members read store" on public.stores for select to authenticated using (public.is_member(id) or public.is_platform_admin());
create policy "owners update store" on public.stores for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));
create policy "members read members" on public.store_members for select to authenticated using (public.is_member(store_id) or public.is_platform_admin());
create policy "owners remove members" on public.store_members for delete to authenticated using (public.is_owner(store_id) and user_id <> auth.uid());
create policy "owners manage invites" on public.store_invites for all to authenticated using (public.is_owner(store_id)) with check (public.is_owner(store_id));
create policy "members read products" on public.products for select to authenticated using (public.is_member(store_id));
create policy "members add products" on public.products for insert to authenticated with check (public.is_member(store_id));
create policy "members edit products" on public.products for update to authenticated using (public.is_member(store_id)) with check (public.is_member(store_id));
create policy "owners delete products" on public.products for delete to authenticated using (public.is_owner(store_id));
create policy "members read renders" on public.renders for select to authenticated using (public.is_member(store_id));
create policy "members update render notes" on public.renders for update to authenticated using (public.is_member(store_id)) with check (public.is_member(store_id));
create policy "members read ledger" on public.credit_ledger for select to authenticated using (public.is_member(store_id) or public.is_platform_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('swatches', 'swatches', false, 15728640, array['image/jpeg','image/png','image/webp']),
  ('rooms',    'rooms',    false, 20971520, array['image/jpeg','image/png','image/webp','image/heic']),
  ('renders',  'renders',  false, 20971520, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "members read swatches" on storage.objects for select to authenticated
  using (bucket_id = 'swatches' and public.is_member(public.path_store(name)));
create policy "members write swatches" on storage.objects for insert to authenticated
  with check (bucket_id = 'swatches' and public.is_member(public.path_store(name)));
create policy "members update swatches" on storage.objects for update to authenticated
  using (bucket_id = 'swatches' and public.is_member(public.path_store(name)));
create policy "members delete swatches" on storage.objects for delete to authenticated
  using (bucket_id = 'swatches' and public.is_member(public.path_store(name)));
create policy "members read rooms" on storage.objects for select to authenticated
  using (bucket_id = 'rooms' and public.is_member(public.path_store(name)));
create policy "members write rooms" on storage.objects for insert to authenticated
  with check (bucket_id = 'rooms' and public.is_member(public.path_store(name)));
create policy "members read renders" on storage.objects for select to authenticated
  using (bucket_id = 'renders' and public.is_member(public.path_store(name)));
