-- Subscription plans. Prices in CAD cents. Stripe price ids filled in once products exist in Stripe.
create table if not exists public.plans (
  id text primary key,
  name text not null,
  monthly_cents int not null,
  annual_cents int not null,            -- per year (2 months free)
  renders_per_month int not null,
  max_users int,                        -- null = unlimited
  max_locations int not null default 1,
  features jsonb not null default '[]'::jsonb,
  stripe_price_month text,
  stripe_price_year text,
  active boolean not null default true,
  sort int not null default 0
);
insert into public.plans (id, name, monthly_cents, annual_cents, renders_per_month, max_users, max_locations, features, sort) values
  ('solo',  'Solo',  5900,  59000,  75,   1,    1, '["75 renders a month","1 user","Proposal PDFs","Supplier catalog & tags"]', 1),
  ('store', 'Store', 17900, 179000, 300,  10,   1, '["300 renders a month","Up to 10 users","Proposal PDFs with your logo","Supplier catalog & tags","In-store setup visit"]', 2),
  ('multi', 'Multi', 39900, 399000, 1200, null, 3, '["1,200 renders a month","Unlimited users, up to 3 locations","Proposal PDFs with your logo","Supplier catalog & tags","In-store setup + quarterly check-in"]', 3)
on conflict (id) do update set name = excluded.name, monthly_cents = excluded.monthly_cents, annual_cents = excluded.annual_cents,
  renders_per_month = excluded.renders_per_month, max_users = excluded.max_users, max_locations = excluded.max_locations, features = excluded.features, sort = excluded.sort;

-- Top-up packs (one-time). Replace the placeholder packs.
delete from public.credit_packs where id in ('starter','growth','pro') and not exists (select 1 from public.credit_ledger where pack_id in ('starter','growth','pro'));
update public.credit_packs set active = false where id in ('starter','growth','pro');
alter table public.credit_packs add column if not exists stripe_price text;
insert into public.credit_packs (id, name, credits, price_cents, currency, sort) values
  ('pack25',  '25 renders',  25,  2900, 'CAD', 1),
  ('pack60',  '60 renders',  60,  4900, 'CAD', 2),
  ('pack150', '150 renders', 150, 9900, 'CAD', 3)
on conflict (id) do update set name = excluded.name, credits = excluded.credits, price_cents = excluded.price_cents, active = true, sort = excluded.sort;

-- Store billing state.
alter table public.stores
  add column if not exists plan_id text references public.plans(id),
  add column if not exists plan_status text not null default 'trial' check (plan_status in ('trial','active','past_due','canceled')),
  add column if not exists billing_interval text check (billing_interval in ('month','year')),
  add column if not exists period_start timestamptz,
  add column if not exists period_end timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists watermark boolean not null default true;
create unique index if not exists stores_stripe_customer_idx on public.stores(stripe_customer_id) where stripe_customer_id is not null;

alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check check (reason in ('trial','purchase','generation','refund','adjustment','plan'));

-- Trial: 10 renders, 14 days, watermarked. Existing create_store grants trial credits from settings; set to 10.
update public.app_settings set value = '10' where key = 'trial_credits';
update public.stores set trial_ends_at = coalesce(trial_ends_at, created_at + interval '14 days') where plan_status = 'trial';

create or replace function public.create_store(p_name text, p_city text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_trial int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'store name required'; end if;
  insert into public.stores (name, city, created_by, plan_status, trial_ends_at, watermark)
    values (trim(p_name), nullif(trim(p_city), ''), auth.uid(), 'trial', now() + interval '14 days', true) returning id into v_store;
  insert into public.store_members (store_id, user_id, role) values (v_store, auth.uid(), 'owner');
  select coalesce((value)::int, 0) into v_trial from public.app_settings where key = 'trial_credits';
  if v_trial > 0 then
    insert into public.credit_ledger (store_id, delta, reason, note, created_by) values (v_store, v_trial, 'trial', 'free trial renders', auth.uid());
  end if;
  return v_store;
end $$;

-- Monthly allowance: renders used this period vs plan. Subscribers draw on allowance first, then purchased credits.
create or replace function public.renders_this_period(p_store uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.renders r join public.stores s on s.id = r.store_id
  where r.store_id = p_store and r.status in ('running','done') and s.period_start is not null and r.created_at >= s.period_start and (s.period_end is null or r.created_at < s.period_end);
$$;

create or replace function public.store_usage(p_store uuid)
returns table (plan_id text, plan_status text, renders_per_month int, used_this_period int, period_end timestamptz, credits int, trial_ends_at timestamptz, watermark boolean)
language sql stable security definer set search_path = public as $$
  select s.plan_id, s.plan_status, coalesce(p.renders_per_month, 0), public.renders_this_period(s.id), s.period_end, public.store_balance(s.id), s.trial_ends_at, s.watermark
  from public.stores s left join public.plans p on p.id = s.plan_id
  where s.id = p_store and (auth.role() = 'service_role' or public.is_member(s.id) or public.is_platform_admin());
$$;
revoke execute on function public.store_usage(uuid) from anon, public;
revoke execute on function public.renders_this_period(uuid) from anon, public;

-- consume_credits: allowance first (no ledger debit), else purchased credits.
create or replace function public.consume_credits(p_store uuid, p_amount int, p_render uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_balance int; v_plan int; v_used int; v_status text;
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if auth.role() <> 'service_role' and not public.is_member(p_store) then raise exception 'not a member'; end if;
  perform 1 from public.stores where id = p_store for update;
  select coalesce(p.renders_per_month, 0), s.plan_status into v_plan, v_status from public.stores s left join public.plans p on p.id = s.plan_id where s.id = p_store;
  if v_status = 'active' and v_plan > 0 then
    v_used := public.renders_this_period(p_store);  -- includes the render row already inserted for this call
    if v_used <= v_plan then
      return v_plan - v_used;  -- covered by the plan, no ledger entry
    end if;
  end if;
  select coalesce(sum(delta), 0) into v_balance from public.credit_ledger where store_id = p_store;
  if v_balance < p_amount then
    raise exception 'insufficient credits (balance %)', v_balance using errcode = 'P0001';
  end if;
  insert into public.credit_ledger (store_id, delta, reason, render_id, created_by) values (p_store, -p_amount, 'generation', p_render, auth.uid());
  return v_balance - p_amount;
end $$;

-- Admin: create a store for someone else (demo in-store), with invite + plan/trial.
create or replace function public.admin_create_store(p_name text, p_city text, p_owner_email text, p_plan text default null, p_credits int default 10)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_store uuid;
begin
  if not public.is_platform_admin() then raise exception 'admin only'; end if;
  insert into public.stores (name, city, created_by, plan_id, plan_status, trial_ends_at, watermark, period_start, period_end)
    values (trim(p_name), nullif(trim(p_city), ''), auth.uid(), p_plan, case when p_plan is null then 'trial' else 'active' end,
            case when p_plan is null then now() + interval '14 days' else null end, p_plan is null,
            case when p_plan is null then null else now() end, case when p_plan is null then null else now() + interval '1 month' end)
    returning id into v_store;
  if coalesce(trim(p_owner_email), '') <> '' then
    insert into public.store_invites (store_id, email, role, created_by) values (v_store, lower(trim(p_owner_email)), 'owner', auth.uid()) on conflict do nothing;
  end if;
  insert into public.store_members (store_id, user_id, role) values (v_store, auth.uid(), 'owner') on conflict do nothing;
  if p_credits > 0 then
    insert into public.credit_ledger (store_id, delta, reason, note, created_by) values (v_store, p_credits, 'trial', 'starter renders', auth.uid());
  end if;
  return v_store;
end $$;
revoke execute on function public.admin_create_store(text, text, text, text, int) from anon, public;

alter table public.plans enable row level security;
create policy "plans readable" on public.plans for select to authenticated using (active);

-- F&M: put them on Store plan, active, no watermark, so the demo account looks like a paying one.
update public.stores set plan_id = 'store', plan_status = 'active', billing_interval = 'month', period_start = now(), period_end = now() + interval '1 month', watermark = false
  where id = '5d148dc0-bf36-4301-a4c2-3d5fbef12458';
