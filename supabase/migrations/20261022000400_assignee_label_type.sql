-- Supabase auth.users.email is varchar; RETURNS TABLE requires an explicit text cast.
-- Backward-compatible correction: code rollback can retain this function unchanged.
create or replace function public.workshop_assignees() returns table(id uuid, label text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission('orders.write') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  return query select u.id,coalesce(u.email::text,u.id::text) from auth.users u where exists (
    select 1 from public.user_roles r where r.user_id = u.id and r.role in ('owner','admin','reception','technician')
  ) order by u.email;
end;
$$;
revoke all on function public.workshop_assignees() from public, anon;
grant execute on function public.workshop_assignees() to authenticated;
