alter table public.products
  add column if not exists surfaces text[] not null default '{floor}',
  add column if not exists rooms text[] not null default '{}',
  add column if not exists tone text,
  add column if not exists hue text,
  add column if not exists tags text[] not null default '{}',
  add column if not exists search tsvector;

create or replace function public.products_search_update() returns trigger language plpgsql as $$
begin
  new.search := to_tsvector('simple', coalesce(new.name,'') || ' ' || coalesce(new.sku,'') || ' ' || coalesce(new.collection,'') || ' ' || coalesce(new.finish,'') || ' ' ||
    coalesce(new.colour_family,'') || ' ' || coalesce(new.notes,'') || ' ' || coalesce(new.tone,'') || ' ' || coalesce(new.hue,'') || ' ' ||
    array_to_string(new.tags,' ') || ' ' || array_to_string(new.rooms,' ') || ' ' || array_to_string(new.surfaces,' '));
  return new;
end $$;
drop trigger if exists products_search_trg on public.products;
create trigger products_search_trg before insert or update on public.products for each row execute function public.products_search_update();
update public.products set name = name; -- backfill search

create index if not exists products_search_idx on public.products using gin (search);
create index if not exists products_tags_idx on public.products using gin (tags);

alter table public.supplier_products
  add column if not exists surfaces text[] not null default '{floor}',
  add column if not exists rooms text[] not null default '{}',
  add column if not exists tone text,
  add column if not exists hue text,
  add column if not exists tags text[] not null default '{}';

update public.products set surfaces = '{wall,floor}' where store_id = '5d148dc0-bf36-4301-a4c2-3d5fbef12458'
  and (name ilike 'Dec %' or name ilike '%Mcharm%' or name ilike '%Versace%' or name ilike '%Fabric Wood%' or name ilike '%Seashell%');
