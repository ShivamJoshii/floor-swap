-- Every 5 minutes, if anything is waiting, ask the autotag function to tag the next batch.
-- Apply after the autotag function is deployed. The token never leaves the database and the function.
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule('autotag-sweep', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://omjbtgdxnwgbojkanksk.supabase.co/functions/v1/autotag',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-autotag-token', (select token from public.autotag_config)),
    body := '{"limit": 20}'::jsonb,
    timeout_milliseconds := 140000)
  where exists (select 1 from public.supplier_products where tagged_at is null and tag_tries < 3)
     or exists (select 1 from public.products where tagged_at is null and tag_tries < 3);
$job$);
