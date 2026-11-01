revoke execute on function public.accept_invites() from anon, public;
revoke execute on function public.admin_stores() from anon, public;
revoke execute on function public.consume_credits(uuid, int, uuid) from anon, authenticated, public;
revoke execute on function public.create_store(text, text) from anon, public;
revoke execute on function public.grant_credits(uuid, int, text, text, text) from anon, public;
revoke execute on function public.is_member(uuid) from anon, public;
revoke execute on function public.is_owner(uuid) from anon, public;
revoke execute on function public.is_platform_admin() from anon, public;
revoke execute on function public.store_balance(uuid) from anon, public;

create or replace function public.path_store(p_name text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

-- Only members (or admins / service role) may read a store's balance.
create or replace function public.store_balance(p_store uuid)
returns int language sql stable security definer set search_path = public as $$
  select case
    when auth.role() = 'service_role' or public.is_member(p_store) or public.is_platform_admin()
      then coalesce((select sum(delta) from public.credit_ledger where store_id = p_store), 0)::int
    else null end;
$$;
