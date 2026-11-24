-- Add an explicit return-cleaning review without weakening legacy finish_block guards.
-- No existing inspection, interval, debt or cash record is rewritten by this migration.
do $$begin
  if to_regprocedure('public.execute_reservation_command(text,jsonb,uuid)') is null
    or position('reservation_command_before_fit' in
      pg_get_functiondef('public.execute_reservation_command(text,jsonb,uuid)'::regprocedure))=0 then
    raise exception 'CLEANING_RECOVERY_SOURCE_MISMATCH';
  end if;
end $$;

alter function public.execute_reservation_command(text,jsonb,uuid) set schema private;
alter function private.execute_reservation_command(text,jsonb,uuid) rename to reservation_command_before_cleaning_review;
revoke all on function private.reservation_command_before_cleaning_review(text,jsonb,uuid) from public,anon,authenticated;

create function public.execute_reservation_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','reservation.'||command,'payload',payload);
  booking public.reservations;
  car public.vehicles;
  block public.vehicle_commitments;
  returned public.rental_inspections;
  latest_return uuid;
  completed_at timestamptz;
  release_blocked boolean;
  result jsonb;
begin
  -- Authorization also precedes cached-result replay, including after permission revocation.
  if auth.uid() is null or not public.has_permission('orders.write') then
    raise exception using errcode='42501',message='PERMISSION_DENIED';
  end if;
  if command is distinct from 'review_return_cleaning' then
    return private.reservation_command_before_cleaning_review(command,payload,idempotency_key);
  end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'INVALID_REQUEST';
  end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;
    return prior.result;
  end if;
  if nullif(btrim(payload->>'reason'),'') is null or length(btrim(payload->>'reason'))>4000 then
    raise exception 'RETURN_CLEANING_REVIEW_REASON_REQUIRED';
  end if;

  select * into booking from public.reservations where id=(payload->>'reservationId')::uuid for update;
  if booking.id is null or booking.status<>'Confirmada' or booking.rental_state<>'Devuelto' then
    raise exception 'RETURN_CLEANING_NOT_REVIEWABLE';
  end if;
  if booking.version is distinct from (payload->>'expectedVersion')::integer then
    raise exception 'VERSION_CONFLICT';
  end if;
  select * into car from public.vehicles where id=booking.vehicle_id for update;
  if car.version is distinct from (payload->>'expectedVehicleVersion')::integer then
    raise exception 'VEHICLE_VERSION_CONFLICT';
  end if;
  select * into block from public.vehicle_commitments where id=(payload->>'blockId')::uuid for update;
  select * into returned from public.rental_inspections where reservation_id=booking.id and kind='Retorno';
  select i.reservation_id into latest_return from public.rental_inspections i
    join public.reservations r on r.id=i.reservation_id
    where r.vehicle_id=car.id and r.status='Confirmada' and r.rental_state in ('Devuelto','Cerrado') and i.kind='Retorno'
    order by i.occurred_at desc,i.id desc limit 1;
  completed_at:=clock_timestamp();
  if block.id is null or block.vehicle_id is distinct from car.id or block.reservation_id is distinct from booking.id
    or block.kind<>'Limpieza' or block.order_id is not null or returned.id is null
    or latest_return is distinct from booking.id
    or not isfinite(returned.occurred_at) or returned.occurred_at>=completed_at
    or block.starts_at<returned.occurred_at or block.starts_at>=completed_at
    or (not block.active and block.reason<>'CONFLICTO de limpieza tras devolución tardía; requiere reprogramación') then
    raise exception 'RETURN_CLEANING_NOT_REVIEWABLE';
  end if;

  -- Review an actual completed cleaning, never activate an interval over another commitment.
  -- The prefix distinguishes successful proof from the generated return-conflict reason.
  update public.vehicle_commitments set ends_at=completed_at,active=false,
    reason='Revisión de limpieza confirmada: '||btrim(payload->>'reason')
    where id=block.id returning * into block;
  release_blocked:=exists(select 1 from public.work_orders where vehicle_id=car.id and status<>'Entregado')
    or exists(select 1 from public.reservations where vehicle_id=car.id and rental_state='Entregado')
    or exists(select 1 from public.vehicle_commitments where vehicle_id=car.id and id<>block.id and active
      and starts_at<=completed_at and ends_at>completed_at);
  if not release_blocked and (car.status<>'Disponible' or car.readiness_hold) then
    update public.vehicles set status='Disponible',readiness_hold=false,version=version+1
      where id=car.id returning * into car;
  end if;
  update public.reservations set version=version+1 where id=booking.id returning * into booking;
  result:=jsonb_build_object('reservation',to_jsonb(booking),'vehicle',to_jsonb(car),'cleaning',to_jsonb(block),
    'cleaningReviewed',true,'releaseBlocked',release_blocked);
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end $$;
revoke all on function public.execute_reservation_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_reservation_command(text,jsonb,uuid) to authenticated;

-- Rollback equivalent (run separately by the migration owner, never after recovery has been used):
-- begin;
-- do $$begin
--   if exists(select 1 from private.command_results where request->>'command'='reservation.review_return_cleaning')
--     then raise exception 'CLEANING_RECOVERY_ALREADY_USED';end if;
-- end $$;
-- drop function public.execute_reservation_command(text,jsonb,uuid);
-- alter function private.reservation_command_before_cleaning_review(text,jsonb,uuid) set schema public;
-- alter function public.reservation_command_before_cleaning_review(text,jsonb,uuid) rename to execute_reservation_command;
-- revoke all on function public.execute_reservation_command(text,jsonb,uuid) from public,anon;
-- grant execute on function public.execute_reservation_command(text,jsonb,uuid) to authenticated;
-- commit;
