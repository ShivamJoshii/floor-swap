-- Website feed: a store with a web_slug publishes its active products that have show_on_website on.
alter table public.products add column if not exists show_on_website boolean not null default true;
alter table public.stores add column if not exists web_slug text;
create unique index if not exists stores_web_slug_key on public.stores (web_slug) where web_slug is not null;

-- Public copies of the photos of published products live here (the swatches and renders buckets stay private).
insert into storage.buckets (id, name, public) values ('storefront', 'storefront', true) on conflict (id) do nothing;

-- Everything the feed needs for one store, with a version stamp per photo so a replaced photo gets a new public copy.
create or replace function public.storefront_products(p_slug text)
returns table (
  store_id uuid, id uuid, name text, sku text, type text, length_in numeric, width_in numeric, finish text,
  colour_family text, hue text, tone text, collection text, tags text[], rooms text[], vibes text[], surfaces text[],
  swatch_path text, swatch_ver bigint, showcase_path text, showcase_ver bigint
) language sql stable security definer set search_path = public as $$
  select s.id, p.id, p.name, p.sku, p.type, p.length_in, p.width_in, p.finish,
    p.colour_family, p.hue, p.tone, p.collection, p.tags, p.rooms, p.vibes, p.surfaces,
    p.swatch_path, (select extract(epoch from o.updated_at)::bigint from storage.objects o where o.bucket_id = 'swatches' and o.name = p.swatch_path),
    p.showcase_path, (select extract(epoch from o.updated_at)::bigint from storage.objects o where o.bucket_id = 'renders' and o.name = p.showcase_path)
  from public.stores s join public.products p on p.store_id = s.id
  where s.web_slug = p_slug and p.active and p.show_on_website
  order by p.name;
$$;
revoke execute on function public.storefront_products(text) from public, anon, authenticated;
grant execute on function public.storefront_products(text) to service_role;
