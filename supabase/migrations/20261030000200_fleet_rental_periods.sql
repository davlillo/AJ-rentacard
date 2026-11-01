-- Fleet membership, indefinite occupancy and charged periods are separate facts.
create table private.rental_fit_functions(signature text primary key,definition text not null);
insert into private.rental_fit_functions select s,pg_get_functiondef(s::regprocedure) from unnest(array[
  'public.execute_reservation_command(text,jsonb,uuid)','public.rental_alternatives(timestamp with time zone,timestamp with time zone,uuid)',
  'private.reservation_command_before_review(text,jsonb,uuid)']) s;
create table private.rental_fit_constraints(table_name text,name text,definition text);
insert into private.rental_fit_constraints select 'reservations',conname,pg_get_constraintdef(oid)
  from pg_constraint where conrelid='public.reservations'::regclass and contype='c' and pg_get_constraintdef(oid) like '%isfinite%';
insert into private.rental_fit_constraints select 'vehicle_commitments',conname,pg_get_constraintdef(oid)
  from pg_constraint where conrelid='public.vehicle_commitments'::regclass and contype='c'
  and (pg_get_constraintdef(oid) like '%kind%' and pg_get_constraintdef(oid) not like '%starts_at%');
do $$ declare c record;begin
  for c in select * from private.rental_fit_constraints loop execute format('alter table public.%I drop constraint %I',c.table_name,c.name);end loop;
end $$;
alter table public.reservations add column open_ended boolean not null default false;
alter table public.reservations add constraint rental_interval_fit check(isfinite(starts_at) and ends_at>starts_at
  and ((open_ended and ends_at='infinity'::timestamptz) or (not open_ended and isfinite(ends_at))));
alter table public.vehicle_commitments add constraint fleet_block_kind check(kind in ('Reserva','Taller','Limpieza','Uso interno','Préstamo'));
alter table public.vehicle_commitments add constraint fleet_block_end check(isfinite(ends_at) or
  (kind in ('Reserva','Taller','Uso interno','Préstamo') and ends_at='infinity'::timestamptz));
create table public.rental_periods(
  id uuid primary key default gen_random_uuid(),reservation_id uuid not null references public.reservations,
  starts_on date not null,ends_on date not null,document_id uuid not null unique references public.billing_documents,
  reason text not null check(length(btrim(reason))>0),created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  check(isfinite(starts_on) and isfinite(ends_on) and ends_on>=starts_on),
  exclude using gist(reservation_id with =,daterange(starts_on,ends_on,'[]') with &&)
);
alter table public.rental_periods enable row level security;
revoke all on public.rental_periods from anon,authenticated;
grant select on public.rental_periods to authenticated;
create policy period_read on public.rental_periods for select to authenticated using(public.has_permission('expenses.read'));
create trigger period_audit after insert on public.rental_periods for each row execute function private.audit_change();
create trigger period_immutable before update or delete on public.rental_periods for each row execute function private.immutable_quote_record();

-- Preserve the old confirmation/cancellation/review rules. Change only the old
-- create guard, which incorrectly equated registration ownership with fleet use.
do $$ declare definition text;begin
  definition:=pg_get_functiondef('private.reservation_command_before_review(text,jsonb,uuid)'::regprocedure);
  if position('car.ownership<>''Propio''' in definition)=0 then raise exception 'RENTAL_FIT_SOURCE_MISMATCH';end if;
  execute replace(definition,'car.ownership<>''Propio''','not car.in_rental_fleet');
end $$;
create or replace function public.rental_alternatives(starts_at timestamptz,ends_at timestamptz,exclude_reservation uuid default null)
returns table(id uuid,plate text,category text) language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('vehicles.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if starts_at is null or ends_at is null or not isfinite(starts_at) or ends_at<=starts_at or ends_at='-infinity'::timestamptz then raise exception 'INVALID_RENTAL_INTERVAL';end if;
  return query select v.id,v.plate,v.category from public.vehicles v where v.in_rental_fleet and not v.readiness_hold
    and not exists(select 1 from public.vehicle_commitments c where c.vehicle_id=v.id and c.active
      and (exclude_reservation is null or c.reservation_id is distinct from exclude_reservation)
      and tstzrange(c.starts_at,c.ends_at,'[)')&&tstzrange(rental_alternatives.starts_at,rental_alternatives.ends_at,'[)'))
    and not(v.status<>'Disponible' and rental_alternatives.starts_at<=now() and not exists(
      select 1 from public.reservations r where r.id=exclude_reservation and r.vehicle_id=v.id and r.rental_state='Entregado')) order by v.plate;
end $$;
alter function public.execute_reservation_command(text,jsonb,uuid) set schema private;
alter function private.execute_reservation_command(text,jsonb,uuid) rename to reservation_command_before_fit;
revoke all on function private.reservation_command_before_fit(text,jsonb,uuid) from public,anon,authenticated;
create function public.execute_reservation_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','reservation.'||command,'payload',payload);
  booking public.reservations;car public.vehicles;customer public.customers;result jsonb;end_time timestamptz;
  doc jsonb;start_day date;end_day date;price numeric;
begin
  if not public.has_permission('orders.write') or (command='period' and not public.has_permission('expenses.write'))
    then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  if command='create' and coalesce((payload->>'openEnded')::boolean,false) then
    select * into car from public.vehicles where id=(payload->>'vehicleId')::uuid for update;
    select * into customer from public.customers where id=(payload->>'customerId')::uuid and merged_into is null;
    if car.id is null or not car.in_rental_fleet or customer.id is null then raise exception 'INVALID_RENTAL_PARTIES';end if;
    price:=(payload->>'dailyRate')::numeric;
    if price is null or price<0 or price<>round(price,2) or price::text in ('NaN','Infinity') then raise exception 'INVALID_RATE_PRECISION';end if;
    insert into public.reservations(customer_id,vehicle_id,starts_at,ends_at,open_ended,daily_rate,total,cleaning_minutes,
      seller_id,customer_snapshot,vehicle_snapshot,created_by)
    values(customer.id,car.id,(payload->>'startsAt')::timestamptz,'infinity',true,price,0,coalesce((payload->>'cleaningMinutes')::integer,0),
      auth.uid(),to_jsonb(customer)-'phone_key'-'document_key',to_jsonb(car),auth.uid()) returning * into booking;
    result:=to_jsonb(booking);
  elsif command in ('confirm','set_end','period') then
    select * into booking from public.reservations where id=(payload->>'reservationId')::uuid for update;
    if booking.id is null then raise exception 'RESERVATION_NOT_FOUND';end if;
    if command<>'period' and booking.version is distinct from (payload->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT';end if;
    if command='period' then
      if booking.status<>'Confirmada' then raise exception 'CONFIRMED_RESERVATION_REQUIRED';end if;
      start_day:=(payload->>'startsOn')::date;end_day:=(payload->>'endsOn')::date;
      if start_day is null or end_day is null or not isfinite(start_day) or not isfinite(end_day) or end_day<start_day
        or start_day<(booking.starts_at at time zone 'America/El_Salvador')::date
        or (isfinite(booking.ends_at) and end_day>(booking.ends_at at time zone 'America/El_Salvador')::date)
        or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_RENTAL_PERIOD';end if;
      doc:=public.execute_billing_command('issue',payload||jsonb_build_object('reservationId',booking.id,
        'description','Alquiler '||start_day||' al '||end_day||' · '||(booking.vehicle_snapshot->>'plate')),gen_random_uuid());
      insert into public.rental_periods(reservation_id,starts_on,ends_on,document_id,reason,created_by)
      values(booking.id,start_day,end_day,(doc->>'id')::uuid,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(rental_periods.*) into result;
    elsif command='confirm' and booking.open_ended then
      if booking.status<>'Borrador' then raise exception 'RESERVATION_NOT_DRAFT';end if;
      if not exists(select 1 from public.rental_alternatives(booking.starts_at,'infinity') where id=booking.vehicle_id) then raise exception using errcode='23P01',message='RENTAL_CONFLICT';end if;
      insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,reason,created_by)
      values(booking.vehicle_id,booking.id,'Reserva',booking.starts_at,'infinity','Alquiler sin fecha final acordada',auth.uid());
      update public.reservations set status='Confirmada',version=version+1 where id=booking.id returning to_jsonb(reservations.*) into result;
    elsif command='set_end' then
      end_time:=(payload->>'endsAt')::timestamptz;
      if not booking.open_ended or booking.status<>'Confirmada' or booking.rental_state not in ('Preparado','Entregado')
        or end_time is null or not isfinite(end_time) or end_time<=greatest(booking.starts_at,now())
        or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_OPEN_RENTAL_END';end if;
      if exists(select 1 from public.rental_periods p where p.reservation_id=booking.id and p.ends_on>(end_time at time zone 'America/El_Salvador')::date) then raise exception 'END_PREDATES_BILLED_PERIOD';end if;
      update public.vehicle_commitments set active=false where reservation_id=booking.id;
      update public.vehicle_commitments set ends_at=end_time,active=true,reason=btrim(payload->>'reason') where reservation_id=booking.id and kind='Reserva';
      if booking.cleaning_minutes>0 then
        insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,reason,created_by)
        values(booking.vehicle_id,booking.id,'Limpieza',end_time,end_time+make_interval(mins=>booking.cleaning_minutes),'Limpieza prevista',auth.uid());
      end if;
      update public.reservations set ends_at=end_time,open_ended=false,
        total=daily_rate*greatest(1,ceil(extract(epoch from(end_time-starts_at))/86400)),version=version+1 where id=booking.id returning to_jsonb(reservations.*) into result;
    else return private.reservation_command_before_fit(command,payload,idempotency_key);end if;
  elsif command='block' and payload->>'kind' in ('Uso interno','Préstamo') then
    if nullif(btrim(payload->>'reason'),'') is null or not exists(select 1 from public.vehicles where id=(payload->>'vehicleId')::uuid and in_rental_fleet) then raise exception 'INVALID_VEHICLE_BLOCK';end if;
    insert into public.vehicle_commitments(vehicle_id,kind,starts_at,ends_at,reason,created_by)
    values((payload->>'vehicleId')::uuid,payload->>'kind',(payload->>'startsAt')::timestamptz,(payload->>'endsAt')::timestamptz,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(vehicle_commitments.*) into result;
  elsif command='finish_block' and exists(select 1 from public.vehicle_commitments where id=(payload->>'blockId')::uuid and kind in ('Uso interno','Préstamo')) then
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'BLOCK_REASON_REQUIRED';end if;
    update public.vehicle_commitments set ends_at=clock_timestamp(),active=false,reason=btrim(payload->>'reason')
      where id=(payload->>'blockId')::uuid and active and starts_at<clock_timestamp() returning to_jsonb(vehicle_commitments.*) into result;
    if result is null then raise exception 'BLOCK_CANNOT_BE_FINISHED';end if;
  else return private.reservation_command_before_fit(command,payload,idempotency_key);end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;
revoke all on function public.execute_reservation_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_reservation_command(text,jsonb,uuid) to authenticated;
create function public.rental_paid_through(reservation_id uuid) returns date language plpgsql stable security definer set search_path='' as $$
declare period record;covered date;begin
  if not public.has_permission('orders.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  select (r.starts_at at time zone 'America/El_Salvador')::date-1 into covered from public.reservations r where r.id=reservation_id;
  for period in select p.*,private.document_balance(p.document_id,'infinity'::date) balance from public.rental_periods p
    where p.reservation_id=rental_paid_through.reservation_id order by p.starts_on loop
    exit when period.starts_on>covered+1 or period.balance>0;
    covered:=greatest(covered,period.ends_on);
  end loop;
  if not exists(select 1 from public.rental_periods p where p.reservation_id=rental_paid_through.reservation_id and p.ends_on=covered) then return null;end if;
  return covered;
end $$;
revoke all on function public.rental_paid_through(uuid) from public,anon;
grant execute on function public.rental_paid_through(uuid) to authenticated;
