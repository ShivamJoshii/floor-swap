create table public.supplier_requests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  requested_by uuid default auth.uid(),
  name text not null check (length(trim(name)) between 1 and 200),
  website text,
  note text,
  status text not null default 'open' check (status in ('open','added','declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.supplier_requests(store_id);
alter table public.supplier_requests enable row level security;
create policy sr_select on public.supplier_requests for select using (public.is_member(store_id) or public.is_platform_admin());
create policy sr_insert on public.supplier_requests for insert with check (public.is_member(store_id) and status = 'open');
create policy sr_admin_update on public.supplier_requests for update using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy sr_admin_delete on public.supplier_requests for delete using (public.is_platform_admin());
grant select, insert on public.supplier_requests to authenticated;
grant update, delete on public.supplier_requests to authenticated;
