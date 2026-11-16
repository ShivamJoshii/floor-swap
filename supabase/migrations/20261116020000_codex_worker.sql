-- ChatGPT (Codex) image route: a job queue between the generate function and one worker machine.
--   * generate inserts a job (prompt, signed input URLs, a signed upload URL) and waits on the row
--   * the worker claims it, generates the image through a ChatGPT subscription, uploads it, marks it done
--   * the worker holds no service key: it calls the three functions below with the publishable key plus a shared secret
--   * the route is only used while the worker's heartbeat is fresh; otherwise generate uses the normal provider

create table if not exists public.codex_worker (
  id int primary key default 1 check (id = 1),
  secret_hash text,                       -- sha256 hex of the worker secret; null = no worker allowed
  last_seen timestamptz,
  ok boolean not null default false,      -- logged in to ChatGPT and not paused on a usage limit
  note text
);
insert into public.codex_worker (id) values (1) on conflict do nothing;

create table if not exists public.codex_jobs (
  id uuid primary key default gen_random_uuid(),
  render_id uuid references public.renders(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  prompt text not null,
  input_urls jsonb not null,              -- signed URLs: room photo, then swatch
  upload_url text not null,               -- signed upload URL for the output PNG
  output_path text not null,              -- path in the renders bucket
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
create index if not exists codex_jobs_queue_idx on public.codex_jobs (status, created_at);

-- Service role only. No policies on purpose.
alter table public.codex_worker enable row level security;
alter table public.codex_jobs enable row level security;
revoke all on public.codex_worker from anon, authenticated;
revoke all on public.codex_jobs from anon, authenticated;

create or replace function public.codex_secret_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select w.secret_hash is not null and w.secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex')
                   from public.codex_worker w where w.id = 1), false);
$$;

create or replace function public.codex_heartbeat(p_secret text, p_ok boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.codex_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.codex_worker set last_seen = now(), ok = coalesce(p_ok, false), note = left(p_note, 500) where id = 1;
end $$;

-- Hands out the oldest waiting job. Jobs nobody is waiting on any more are closed first.
create or replace function public.codex_claim(p_secret text)
returns table (id uuid, prompt text, input_urls jsonb, upload_url text)
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.codex_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.codex_jobs j set status = 'cancelled', error = 'expired before a worker picked it up', finished_at = now()
    where j.status = 'pending' and j.created_at < now() - interval '90 seconds';
  update public.codex_jobs j set status = 'failed', error = 'worker stopped mid-job', finished_at = now()
    where j.status = 'running' and j.claimed_at < now() - interval '10 minutes';
  select j.id into v_id from public.codex_jobs j where j.status = 'pending' order by j.created_at limit 1 for update skip locked;
  if v_id is null then return; end if;
  return query update public.codex_jobs j set status = 'running', claimed_at = now() where j.id = v_id
    returning j.id, j.prompt, j.input_urls, j.upload_url;
end $$;

create or replace function public.codex_finish(p_secret text, p_id uuid, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.codex_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.codex_jobs set status = case when p_ok then 'done' else 'failed' end, error = left(p_error, 500), finished_at = now()
    where id = p_id and status = 'running';
end $$;

revoke execute on function public.codex_secret_ok(text) from public, anon, authenticated;
revoke execute on function public.codex_heartbeat(text, boolean, text) from public;
revoke execute on function public.codex_claim(text) from public;
revoke execute on function public.codex_finish(text, uuid, boolean, text) from public;
grant execute on function public.codex_heartbeat(text, boolean, text) to anon;
grant execute on function public.codex_claim(text) to anon;
grant execute on function public.codex_finish(text, uuid, boolean, text) to anon;

-- Off by default: add store ids here to send that store's renders through ChatGPT first.
insert into public.app_settings (key, value) values ('codex_store_ids', '[]'::jsonb), ('codex_wait_seconds', '75'::jsonb)
  on conflict (key) do nothing;
