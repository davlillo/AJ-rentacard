-- Unwind this wrapper before rolling back any earlier reservation-command migration.
-- Recorded reviews are durable facts: never remove recovery after it has been used.
begin;
do $$begin
  if exists(select 1 from private.command_results where request->>'command'='reservation.review_return_cleaning')
    then raise exception 'CLEANING_RECOVERY_ALREADY_USED';end if;
end $$;
drop function public.execute_reservation_command(text,jsonb,uuid);
alter function private.reservation_command_before_cleaning_review(text,jsonb,uuid) set schema public;
alter function public.reservation_command_before_cleaning_review(text,jsonb,uuid) rename to execute_reservation_command;
revoke all on function public.execute_reservation_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_reservation_command(text,jsonb,uuid) to authenticated;
commit;
