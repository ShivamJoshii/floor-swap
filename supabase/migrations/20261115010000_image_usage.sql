-- Usage is counted per image, not per render.
--   * every generated image (room render or product room photo) draws on the monthly allowance, then on top-ups
--   * the allowance runs in monthly windows anchored on period_start, so yearly and hand-set plans reset every month
--   * image_usage is the full history of what was generated

create table if not exists public.image_usage (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid,
  kind text not null check (kind in ('render', 'showcase')),
  render_id uuid references public.renders(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  images int not null check (images >= 0),          -- images charged (after settle: images delivered)
  plan_images int not null default 0 check (plan_images >= 0),      -- taken from the monthly allowance
  credit_images int not null default 0 check (credit_images >= 0),  -- taken from top-ups / trial
  model text,
  cost_cents numeric not null default 0,            -- provider cost, admin only
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists image_usage_store_idx on public.image_usage (store_id, created_at desc);

-- Stores read their history through store_image_history() (no cost column); the table itself is admin only.
alter table public.image_usage enable row level security;
drop policy if exists "image_usage admin read" on public.image_usage;
create policy "image_usage admin read" on public.image_usage for select to authenticated using (public.is_platform_admin());
revoke insert, update, delete on public.image_usage from anon, authenticated;

-- Current monthly window for a store's allowance.
create or replace function public.allowance_window(p_store uuid)
returns table (ws timestamptz, we timestamptz) language sql stable security definer set search_path = public as $$
  select s.period_start + make_interval(months => k.n), s.period_start + make_interval(months => k.n + 1)
  from public.stores s,
    lateral (select greatest(0, (extract(year from age(now(), s.period_start)) * 12 + extract(month from age(now(), s.period_start)))::int) as n) k
  where s.id = p_store and s.period_start is not null;
$$;

create or replace function public.images_this_period(p_store uuid)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(sum(u.plan_images), 0)::int
  from public.image_usage u, public.allowance_window(p_store) w
  where u.store_id = p_store and u.created_at >= w.ws;
$$;

-- Charge p_images up front: allowance first, then top-ups. Raises P0001 when there is not enough for all of them.
create or replace function public.consume_images(p_store uuid, p_images int, p_kind text, p_user uuid default null, p_render uuid default null,
  p_product uuid default null, p_product_name text default null, p_model text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_plan int; v_status text; v_left int := 0; v_balance int; v_from_plan int; v_from_credit int; v_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service only'; end if;
  if p_images <= 0 then raise exception 'images must be positive'; end if;
  perform 1 from public.stores where id = p_store for update;
  select coalesce(p.renders_per_month, 0), s.plan_status into v_plan, v_status
    from public.stores s left join public.plans p on p.id = s.plan_id where s.id = p_store;
  if v_status = 'active' and v_plan > 0 then
    v_left := greatest(0, v_plan - public.images_this_period(p_store));
  end if;
  select coalesce(sum(delta), 0) into v_balance from public.credit_ledger where store_id = p_store;
  v_balance := greatest(0, v_balance);
  if v_left + v_balance < p_images then
    raise exception 'insufficient images (% left)', v_left + v_balance using errcode = 'P0001';
  end if;
  v_from_plan := least(v_left, p_images);
  v_from_credit := p_images - v_from_plan;
  insert into public.image_usage (store_id, user_id, kind, render_id, product_id, product_name, images, plan_images, credit_images, model)
    values (p_store, p_user, p_kind, p_render, p_product, p_product_name, p_images, v_from_plan, v_from_credit, p_model)
    returning id into v_id;
  if v_from_credit > 0 then
    insert into public.credit_ledger (store_id, delta, reason, render_id, note, created_by)
      values (p_store, -v_from_credit, 'generation', p_render, case when p_kind = 'showcase' then 'product room photo' else null end, p_user);
  end if;
  return v_id;
end $$;

-- After generating: keep the charge for what was delivered, give back the rest (top-ups first, then allowance).
create or replace function public.settle_images(p_usage uuid, p_delivered int, p_cost numeric default 0, p_model text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u public.image_usage; v_back int; v_credit_back int;
begin
  if auth.role() <> 'service_role' then raise exception 'service only'; end if;
  select * into u from public.image_usage where id = p_usage for update;
  if not found or u.status <> 'running' then return; end if;
  v_back := greatest(0, u.images - greatest(0, p_delivered));
  v_credit_back := least(v_back, u.credit_images);
  if v_credit_back > 0 then
    insert into public.credit_ledger (store_id, delta, reason, render_id, note)
      values (u.store_id, v_credit_back, 'refund', u.render_id, 'image not delivered');
  end if;
  update public.image_usage set
    images = u.images - v_back,
    credit_images = u.credit_images - v_credit_back,
    plan_images = u.plan_images - (v_back - v_credit_back),
    cost_cents = coalesce(p_cost, 0),
    model = coalesce(p_model, u.model),
    status = case when u.images - v_back > 0 then 'done' else 'failed' end
  where id = p_usage;
end $$;

revoke execute on function public.allowance_window(uuid) from anon, authenticated, public;
revoke execute on function public.images_this_period(uuid) from anon, authenticated, public;
revoke execute on function public.consume_images(uuid, int, text, uuid, uuid, uuid, text, text) from anon, authenticated, public;
revoke execute on function public.settle_images(uuid, int, numeric, text) from anon, authenticated, public;

-- Same shape as before; the numbers are now images in the current monthly window.
create or replace function public.store_usage(p_store uuid)
returns table (plan_id text, plan_status text, renders_per_month int, used_this_period int, period_end timestamptz, credits int, trial_ends_at timestamptz, watermark boolean)
language sql stable security definer set search_path = public as $$
  select s.plan_id, s.plan_status, coalesce(p.renders_per_month, 0), public.images_this_period(s.id),
    (select w.we from public.allowance_window(s.id) w), public.store_balance(s.id), s.trial_ends_at, s.watermark
  from public.stores s left join public.plans p on p.id = s.plan_id
  where s.id = p_store and (auth.role() = 'service_role' or public.is_member(s.id) or public.is_platform_admin());
$$;

-- What a store sees: every image generation, newest first. Counts only, no cost.
create or replace function public.store_image_history(p_store uuid, p_limit int default 50, p_before timestamptz default null)
returns table (id uuid, created_at timestamptz, kind text, product_name text, images int, plan_images int, credit_images int, status text, who text, thumb_path text)
language sql stable security definer set search_path = public as $$
  select u.id, u.created_at, u.kind, coalesce(u.product_name, pr.name), u.images, u.plan_images, u.credit_images, u.status,
    (select au.email::text from auth.users au where au.id = u.user_id),
    case when u.kind = 'render' then (select r.outputs -> 0 ->> 'path' from public.renders r where r.id = u.render_id and jsonb_typeof(r.outputs) = 'array')
         else pr.showcase_path end
  from public.image_usage u left join public.products pr on pr.id = u.product_id
  where u.store_id = p_store and u.status <> 'running'
    and (auth.role() = 'service_role' or public.is_member(p_store) or public.is_platform_admin())
    and (p_before is null or u.created_at < p_before)
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke execute on function public.store_image_history(uuid, int, timestamptz) from anon, public;

-- Admin: images and provider cost per store.
create or replace function public.admin_usage()
returns table (store_id uuid, images_30d int, cost_cents_30d numeric, images_total int, cost_cents_total numeric, last_image timestamptz)
language sql stable security definer set search_path = public as $$
  select u.store_id,
    coalesce(sum(u.images) filter (where u.created_at >= now() - interval '30 days'), 0)::int,
    coalesce(sum(u.cost_cents) filter (where u.created_at >= now() - interval '30 days'), 0),
    coalesce(sum(u.images), 0)::int, coalesce(sum(u.cost_cents), 0), max(u.created_at)
  from public.image_usage u
  where public.is_platform_admin()
  group by u.store_id;
$$;
revoke execute on function public.admin_usage() from anon, public;

-- History for what was generated before this change.
insert into public.image_usage (store_id, user_id, kind, render_id, product_id, product_name, images, plan_images, credit_images, model, cost_cents, status, created_at)
select r.store_id, r.user_id, 'render', r.id, r.product_id, p.name, n.images,
  case when l.render_id is null then n.images else 0 end,
  case when l.render_id is null then 0 else 1 end,
  r.model, coalesce(r.provider_cost_cents, 0), 'done', r.created_at
from public.renders r
  left join public.products p on p.id = r.product_id
  left join lateral (select case when jsonb_typeof(r.outputs) = 'array' then jsonb_array_length(r.outputs) else 0 end as images) n on true
  left join lateral (select g.render_id from public.credit_ledger g where g.render_id = r.id and g.reason = 'generation' limit 1) l on true
where r.status = 'done' and n.images > 0
  and not exists (select 1 from public.image_usage u where u.render_id = r.id);

insert into public.image_usage (store_id, kind, product_id, product_name, images, plan_images, credit_images, status, created_at)
select p.store_id, 'showcase', p.id, p.name, 1, 0, 0, 'done', coalesce(p.showcase_updated_at, p.created_at)
from public.products p
where p.showcase_path is not null
  and not exists (select 1 from public.image_usage u where u.product_id = p.id and u.kind = 'showcase');

-- Wording: plans and packs are sold in images.
update public.plans set features = replace(features::text, 'renders a month', 'images a month')::jsonb;
update public.credit_packs set name = replace(name, ' renders', ' images') where name like '% renders';

-- Google direct runs Nano Banana Pro. Cost is cents per image.
update public.app_settings set value = '"gemini-3-pro-image"'::jsonb where key = 'google_model';
update public.app_settings set value = value || '{"gemini-3-pro-image": 13.4}'::jsonb where key = 'model_costs';
