-- Suppliers: who owns them, contact info, whether listed in the marketplace.
alter table public.suppliers
  add column if not exists owner_store_id uuid references public.stores(id) on delete set null,   -- a store acting as supplier
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists city text,
  add column if not exists description text,
  add column if not exists listed boolean not null default false,          -- visible in Marketplace
  add column if not exists claimed boolean not null default false,          -- someone owns this supplier record
  add column if not exists logo_path text;

-- Supplier team: standalone supplier users (no store).
create table if not exists public.supplier_members (
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (supplier_id, user_id)
);
create index if not exists supplier_members_user_idx on public.supplier_members(user_id);

create table if not exists public.supplier_invites (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  email text not null,
  role text not null default 'staff' check (role in ('owner','staff')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (supplier_id, email)
);

-- Listing flag per product (supplier chooses what's public).
alter table public.supplier_products
  add column if not exists listed boolean not null default true,
  add column if not exists lead_time text,
  add column if not exists min_order text,
  add column if not exists updated_at timestamptz not null default now();

-- Inquiries: store -> supplier about a product (or general).
create table if not exists public.inquiries (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  supplier_product_id uuid references public.supplier_products(id) on delete set null,
  from_store_id uuid not null references public.stores(id) on delete cascade,
  from_user_id uuid references auth.users(id) on delete set null,
  subject text,
  status text not null default 'open' check (status in ('open','replied','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inquiries_supplier_idx on public.inquiries(supplier_id, updated_at desc);
create index if not exists inquiries_store_idx on public.inquiries(from_store_id, updated_at desc);

create table if not exists public.inquiry_messages (
  id bigserial primary key,
  inquiry_id uuid not null references public.inquiries(id) on delete cascade,
  sender_user_id uuid references auth.users(id) on delete set null,
  sender_side text not null check (sender_side in ('store','supplier')),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists inquiry_messages_idx on public.inquiry_messages(inquiry_id, created_at);

-- Helpers
create or replace function public.is_supplier_member(p_supplier uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.supplier_members where supplier_id = p_supplier and user_id = auth.uid())
      or exists (select 1 from public.suppliers s join public.store_members m on m.store_id = s.owner_store_id where s.id = p_supplier and m.user_id = auth.uid());
$$;
revoke execute on function public.is_supplier_member(uuid) from anon, public;

-- A store turns itself into a supplier (or claims an existing unclaimed one by name).
create or replace function public.store_become_supplier(p_store uuid, p_name text, p_email text default null, p_phone text default null, p_city text default null, p_description text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_owner(p_store) then raise exception 'store owner only'; end if;
  select id into v_id from public.suppliers where owner_store_id = p_store limit 1;
  if v_id is null then
    select id into v_id from public.suppliers where lower(name) = lower(trim(p_name)) and store_id is null and claimed = false limit 1;
  end if;
  if v_id is null then
    insert into public.suppliers (name, store_id, created_by, owner_store_id, contact_email, contact_phone, city, description, listed, claimed)
      values (trim(p_name), null, auth.uid(), p_store, p_email, p_phone, p_city, p_description, true, true) returning id into v_id;
  else
    update public.suppliers set owner_store_id = p_store, contact_email = coalesce(p_email, contact_email), contact_phone = coalesce(p_phone, contact_phone),
      city = coalesce(p_city, city), description = coalesce(p_description, description), listed = true, claimed = true where id = v_id;
  end if;
  return v_id;
end $$;
revoke execute on function public.store_become_supplier(uuid, text, text, text, text, text) from anon, public;

-- Standalone supplier signup.
create or replace function public.create_supplier(p_name text, p_email text default null, p_phone text default null, p_city text default null, p_description text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into v_id from public.suppliers where lower(name) = lower(trim(p_name)) and store_id is null and claimed = false limit 1;
  if v_id is null then
    insert into public.suppliers (name, created_by, contact_email, contact_phone, city, description, listed, claimed)
      values (trim(p_name), auth.uid(), p_email, p_phone, p_city, p_description, true, true) returning id into v_id;
  else
    update public.suppliers set contact_email = coalesce(p_email, contact_email), contact_phone = coalesce(p_phone, contact_phone), city = coalesce(p_city, city),
      description = coalesce(p_description, description), listed = true, claimed = true where id = v_id;
  end if;
  insert into public.supplier_members (supplier_id, user_id, role) values (v_id, auth.uid(), 'owner') on conflict do nothing;
  return v_id;
end $$;
revoke execute on function public.create_supplier(text, text, text, text, text) from anon, public;

create or replace function public.accept_supplier_invites()
returns int language plpgsql security definer set search_path = public as $$
declare v_email text; v_count int := 0; r record;
begin
  select email into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  for r in select * from public.supplier_invites where lower(email) = lower(v_email) and accepted_at is null loop
    insert into public.supplier_members (supplier_id, user_id, role) values (r.supplier_id, auth.uid(), r.role) on conflict do nothing;
    update public.supplier_invites set accepted_at = now() where id = r.id; v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function public.accept_supplier_invites() from anon, public;

-- Store sends an inquiry (creates thread + first message).
create or replace function public.send_inquiry(p_store uuid, p_supplier uuid, p_product uuid, p_subject text, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_member(p_store) then raise exception 'not a member'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'message required'; end if;
  insert into public.inquiries (supplier_id, supplier_product_id, from_store_id, from_user_id, subject)
    values (p_supplier, p_product, p_store, auth.uid(), nullif(trim(p_subject), '')) returning id into v_id;
  insert into public.inquiry_messages (inquiry_id, sender_user_id, sender_side, body) values (v_id, auth.uid(), 'store', trim(p_body));
  return v_id;
end $$;
revoke execute on function public.send_inquiry(uuid, uuid, uuid, text, text) from anon, public;

create or replace function public.reply_inquiry(p_inquiry uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare v_sup uuid; v_store uuid; v_side text;
begin
  select supplier_id, from_store_id into v_sup, v_store from public.inquiries where id = p_inquiry;
  if v_sup is null then raise exception 'not found'; end if;
  if public.is_supplier_member(v_sup) then v_side := 'supplier';
  elsif public.is_member(v_store) then v_side := 'store';
  else raise exception 'not allowed'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'message required'; end if;
  insert into public.inquiry_messages (inquiry_id, sender_user_id, sender_side, body) values (p_inquiry, auth.uid(), v_side, trim(p_body));
  update public.inquiries set status = case when v_side = 'supplier' then 'replied' else 'open' end, updated_at = now() where id = p_inquiry;
end $$;
revoke execute on function public.reply_inquiry(uuid, text) from anon, public;

-- Marketplace listing view: only listed products of listed suppliers; no prices exist here anyway.
create or replace view public.marketplace_products as
  select sp.id, sp.supplier_id, s.name as supplier_name, s.city as supplier_city, s.claimed as supplier_claimed, s.owner_store_id,
         sp.sku, sp.name, sp.type, sp.length_in, sp.width_in, sp.thickness_mm, sp.finish, sp.colour_family, sp.collection, sp.notes, sp.swatch_path,
         sp.surfaces, sp.rooms, sp.tone, sp.hue, sp.tags, sp.lead_time, sp.min_order, sp.updated_at
  from public.supplier_products sp join public.suppliers s on s.id = sp.supplier_id
  where sp.listed and (s.listed or s.claimed = false);   -- unclaimed catalogs (imported) stay browsable so stores find them; claiming turns on contact
grant select on public.marketplace_products to authenticated;

-- RLS
alter table public.supplier_members enable row level security;
alter table public.supplier_invites enable row level security;
alter table public.inquiries enable row level security;
alter table public.inquiry_messages enable row level security;

create policy "supplier members read" on public.supplier_members for select to authenticated using (public.is_supplier_member(supplier_id) or user_id = auth.uid());
create policy "supplier owners manage invites" on public.supplier_invites for all to authenticated using (public.is_supplier_member(supplier_id)) with check (public.is_supplier_member(supplier_id));

drop policy if exists "edit own suppliers" on public.suppliers;
create policy "edit own suppliers" on public.suppliers for update to authenticated
  using (created_by = auth.uid() or public.is_platform_admin() or public.is_supplier_member(id) or (store_id is not null and public.is_owner(store_id)));

drop policy if exists "edit own catalog rows" on public.supplier_products;
create policy "edit own catalog rows" on public.supplier_products for update to authenticated using (created_by = auth.uid() or public.is_platform_admin() or public.is_supplier_member(supplier_id));
drop policy if exists "delete own catalog rows" on public.supplier_products;
create policy "delete own catalog rows" on public.supplier_products for delete to authenticated using (created_by = auth.uid() or public.is_platform_admin() or public.is_supplier_member(supplier_id));

create policy "inquiry parties read" on public.inquiries for select to authenticated using (public.is_member(from_store_id) or public.is_supplier_member(supplier_id) or public.is_platform_admin());
create policy "inquiry parties update" on public.inquiries for update to authenticated using (public.is_member(from_store_id) or public.is_supplier_member(supplier_id));
create policy "inquiry msgs read" on public.inquiry_messages for select to authenticated
  using (exists (select 1 from public.inquiries i where i.id = inquiry_id and (public.is_member(i.from_store_id) or public.is_supplier_member(i.supplier_id) or public.is_platform_admin())));

-- Catalog bucket: supplier members can write under their supplier id too.
create policy "supplier swatch upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'catalog' and (split_part(name, '/', 1) = auth.uid()::text or public.is_supplier_member(public.path_store(name))));

-- Imported suppliers: mark contact info we know. Eksa / Toucan / Prime Floor stay unclaimed until they sign up.
update public.suppliers set city = 'Edmonton' where lower(name) in ('eksa tile','toucan flooring','prime floor') and city is null;
