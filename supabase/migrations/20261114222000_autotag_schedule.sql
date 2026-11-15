-- Tag anything untagged, every minute, 12 at a time (stays inside a low per-minute AI rate limit).
-- Does nothing when the queue is empty. The token is read at run time, so rotating it needs no change here.
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- New sweep token.
update public.autotag_config set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

select cron.unschedule(jobid) from cron.job where jobname = 'autotag-sweep';
select cron.schedule('autotag-sweep', '* * * * *', $job$
  select net.http_post(
    url := 'https://omjbtgdxnwgbojkanksk.supabase.co/functions/v1/autotag',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-autotag-token', (select token from public.autotag_config)),
    body := '{"limit": 12}'::jsonb,
    timeout_milliseconds := 55000)
  where exists (select 1 from public.supplier_products where tagged_at is null and tag_tries < 3)
     or exists (select 1 from public.products where tagged_at is null and tag_tries < 3);
$job$);
