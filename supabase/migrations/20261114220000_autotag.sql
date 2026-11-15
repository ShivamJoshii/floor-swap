-- Auto-tagging: vibe field, tagging bookkeeping, search that also matches vibe and size, and a private token the scheduled sweep uses to call the autotag function.

alter table public.products
  add column if not exists vibes text[] not null default '{}',
  add column if not exists tagged_at timestamptz,
  add column if not exists tag_error text,
  add column if not exists tag_tries int not null default 0;

alter table public.supplier_products
  add column if not exists vibes text[] not null default '{}',
  add column if not exists tagged_at timestamptz,
  add column if not exists tag_error text,
  add column if not exists tag_tries int not null default 0;

create or replace function public.products_search_update() returns trigger language plpgsql as $$
declare sz text := '';
begin
  if new.length_in is not null and new.width_in is not null then
    sz := trim(to_char(least(new.length_in, new.width_in), 'FM999990.##'), '.') || 'x' || trim(to_char(greatest(new.length_in, new.width_in), 'FM999990.##'), '.');
  end if;
  new.search := to_tsvector('simple', coalesce(new.name,'') || ' ' || coalesce(new.sku,'') || ' ' || coalesce(new.collection,'') || ' ' || coalesce(new.finish,'') || ' ' ||
    coalesce(new.colour_family,'') || ' ' || coalesce(new.notes,'') || ' ' || coalesce(new.tone,'') || ' ' || coalesce(new.hue,'') || ' ' || sz || ' ' ||
    array_to_string(new.tags,' ') || ' ' || array_to_string(new.rooms,' ') || ' ' || array_to_string(new.surfaces,' ') || ' ' || array_to_string(new.vibes,' '));
  return new;
end $$;

update public.products set name = name; -- refresh search

create index if not exists products_vibes_idx on public.products using gin (vibes);
create index if not exists products_untagged_idx on public.products (created_at) where tagged_at is null;
create index if not exists supplier_products_untagged_idx on public.supplier_products (created_at) where tagged_at is null;

-- One-row table holding the token the scheduled sweep sends. RLS on with no policies: only the service role and the database owner can read it.
create table if not exists public.autotag_config (
  id boolean primary key default true check (id),
  token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
alter table public.autotag_config enable row level security;
revoke all on public.autotag_config from anon, authenticated;
insert into public.autotag_config (id) values (true) on conflict do nothing;

-- The marketplace view lists its columns, so the new one is appended (create or replace only allows adding at the end).
create or replace view public.marketplace_products as
  select sp.id, sp.supplier_id, s.name as supplier_name, s.city as supplier_city, s.claimed as supplier_claimed, s.owner_store_id,
    sp.sku, sp.name, sp.type, sp.length_in, sp.width_in, sp.thickness_mm, sp.finish, sp.colour_family, sp.collection, sp.notes, sp.swatch_path,
    sp.surfaces, sp.rooms, sp.tone, sp.hue, sp.tags, sp.lead_time, sp.min_order, sp.updated_at, sp.vibes
  from public.supplier_products sp join public.suppliers s on s.id = sp.supplier_id
  where sp.listed and (s.listed or s.claimed = false);
grant select on public.marketplace_products to authenticated;
