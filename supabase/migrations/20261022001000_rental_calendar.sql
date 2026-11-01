-- HU13-HU16: one authoritative interval ledger for reservations, workshop and cleaning.
create extension if not exists btree_gist with schema public;
alter table public.vehicles add column readiness_hold boolean not null default false;
create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers,
  vehicle_id uuid not null references public.vehicles,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  daily_rate numeric(14,2) not null check(daily_rate>=0 and daily_rate::text not in ('NaN','Infinity')),
  total numeric(14,2) not null check(total>=0 and total::text not in ('NaN','Infinity')),
  cleaning_minutes integer not null default 0 check(cleaning_minutes between 0 and 10080),
  status text not null default 'Borrador' check(status in ('Borrador','Confirmada','Cancelada')),
  rental_state text not null default 'Preparado' check(rental_state in ('Preparado','Entregado','Devuelto','Cerrado')),
  seller_id uuid not null references auth.users,
  customer_snapshot jsonb not null,
  vehicle_snapshot jsonb not null,
  version integer not null default 1,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  check(isfinite(starts_at) and isfinite(ends_at) and ends_at>starts_at)
);
create table public.vehicle_commitments (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles,
  reservation_id uuid references public.reservations,
  order_id text references public.work_orders,
  kind text not null check(kind in ('Reserva','Taller','Limpieza')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  reason text not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  check(isfinite(starts_at) and ends_at>starts_at),
  check(isfinite(ends_at) or (kind='Taller' and ends_at='infinity'::timestamptz)),
  exclude using gist(vehicle_id with =,tstzrange(starts_at,ends_at,'[)') with &&) where(active)
);
create unique index commitment_reservation_kind on public.vehicle_commitments(reservation_id,kind) where reservation_id is not null;
create unique index commitment_work_order on public.vehicle_commitments(order_id) where order_id is not null;
create table public.reservation_evidence (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations,
  channel text not null default 'WhatsApp',
  body text not null check(length(btrim(body)) between 1 and 20000),
  occurred_at timestamptz not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
alter table public.reservations enable row level security;
alter table public.vehicle_commitments enable row level security;
alter table public.reservation_evidence enable row level security;
revoke all on public.reservations,public.vehicle_commitments,public.reservation_evidence from anon,authenticated;
grant select on public.reservations,public.vehicle_commitments,public.reservation_evidence to authenticated;
create policy reservation_read on public.reservations for select to authenticated using(public.has_permission('orders.read'));
create policy commitment_read on public.vehicle_commitments for select to authenticated using(public.has_permission('vehicles.read'));
create policy reservation_evidence_read on public.reservation_evidence for select to authenticated using(public.has_permission('orders.read'));
create trigger reservation_audit after insert or update on public.reservations for each row execute function private.audit_change();
create trigger commitment_audit after insert or update on public.vehicle_commitments for each row execute function private.audit_change();
create trigger reservation_evidence_audit after insert on public.reservation_evidence for each row execute function private.audit_change();
create trigger reservation_evidence_immutable before update or delete on public.reservation_evidence for each row execute function private.immutable_quote_record();

-- Unknown workshop duration is an explicit open-ended block, not invented availability.
insert into public.vehicle_commitments(vehicle_id,order_id,kind,starts_at,ends_at,reason,created_by)
select vehicle_id,id,'Taller',occurred_at,'infinity','Ingreso de taller sin fecha de liberación',created_by
from public.work_orders where status<>'Entregado';
create function private.workshop_commitment() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(6192,1);
  if TG_OP='INSERT' then
    insert into public.vehicle_commitments(vehicle_id,order_id,kind,starts_at,ends_at,reason,created_by)
    values(new.vehicle_id,new.id,'Taller',new.occurred_at,'infinity','Ingreso de taller',new.created_by);
  elsif new.status='Entregado' and old.status<>'Entregado' then
    update public.vehicle_commitments set ends_at=greatest(clock_timestamp(),starts_at+interval '1 microsecond'),
      reason='Entrega de taller registrada' where order_id=new.id;
  end if;
  return new;
end;
$$;
create trigger workshop_commitment after insert or update on public.work_orders for each row execute function private.workshop_commitment();

-- Merging identity updates live relations; historical snapshots remain unchanged.
create function private.merge_reservation_identity() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.merged_into is not null and old.merged_into is null then
    update public.reservations set customer_id=new.merged_into,version=version+1 where customer_id=new.id;
  end if;
  return new;
end;
$$;
create trigger reservation_identity after update on public.customers for each row execute function private.merge_reservation_identity();

create function public.rental_alternatives(starts_at timestamptz,ends_at timestamptz,exclude_reservation uuid default null)
returns table(id uuid,plate text,category text) language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('vehicles.read') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if starts_at is null or ends_at is null or not isfinite(starts_at) or not isfinite(ends_at) or ends_at<=starts_at then raise exception 'INVALID_RENTAL_INTERVAL'; end if;
  return query select v.id,v.plate,v.category from public.vehicles v where v.ownership='Propio'
    and not v.readiness_hold
    and not exists(select 1 from public.vehicle_commitments c where c.vehicle_id=v.id and c.active
      and (exclude_reservation is null or c.reservation_id is distinct from exclude_reservation)
      and tstzrange(c.starts_at,c.ends_at,'[)') && tstzrange(rental_alternatives.starts_at,rental_alternatives.ends_at,'[)'))
    and not(v.status<>'Disponible' and rental_alternatives.starts_at<=now() and not exists(
      select 1 from public.reservations r where r.id=exclude_reservation and r.vehicle_id=v.id and r.rental_state='Entregado'))
    order by v.plate;
end;
$$;

create function public.execute_reservation_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','reservation.'||command,'payload',payload);
  booking public.reservations;
  car public.vehicles;
  customer public.customers;
  start_time timestamptz;
  end_time timestamptz;
  result jsonb;
  seller uuid;
begin
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('create','confirm','cancel','extend','evidence','block','finish_block','plan_workshop')
    or idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_RESERVATION_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if command='create' then
    select * into car from public.vehicles where id=(payload->>'vehicleId')::uuid for update;
    select * into customer from public.customers where id=(payload->>'customerId')::uuid and merged_into is null;
    if car.id is null or car.ownership<>'Propio' or customer.id is null then raise exception 'INVALID_RENTAL_PARTIES'; end if;
    start_time:=(payload->>'startsAt')::timestamptz;end_time:=(payload->>'endsAt')::timestamptz;
    if (payload->>'dailyRate')::numeric<>round((payload->>'dailyRate')::numeric,2) then raise exception 'INVALID_RATE_PRECISION'; end if;
    seller:=coalesce((payload->>'sellerId')::uuid,auth.uid());
    if not exists(select 1 from public.user_roles where user_id=seller and role in ('owner','admin','reception')) then raise exception 'INVALID_SELLER'; end if;
    insert into public.reservations(customer_id,vehicle_id,starts_at,ends_at,daily_rate,total,cleaning_minutes,
      seller_id,customer_snapshot,vehicle_snapshot,created_by)
    values(customer.id,car.id,start_time,end_time,(payload->>'dailyRate')::numeric,
      (payload->>'dailyRate')::numeric*greatest(1,ceil(extract(epoch from(end_time-start_time))/86400)),
      coalesce((payload->>'cleaningMinutes')::integer,0),seller,to_jsonb(customer)-'phone_key'-'document_key',to_jsonb(car),auth.uid()) returning * into booking;
    result:=to_jsonb(booking);
  elsif command in ('confirm','cancel','extend','evidence') then
    select * into booking from public.reservations where id=(payload->>'reservationId')::uuid for update;
    if booking.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;
    if command<>'evidence' and (payload->>'expectedVersion')::integer is distinct from booking.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    if command='evidence' then
      insert into public.reservation_evidence(reservation_id,channel,body,occurred_at,created_by)
      values(booking.id,'WhatsApp',btrim(payload->>'body'),coalesce((payload->>'occurredAt')::timestamptz,now()),auth.uid()) returning to_jsonb(reservation_evidence.*) into result;
    elsif command='confirm' then
      if booking.status<>'Borrador' then raise exception 'RESERVATION_NOT_DRAFT'; end if;
      if not exists(select 1 from public.rental_alternatives(booking.starts_at,booking.ends_at+make_interval(mins=>booking.cleaning_minutes)) where id=booking.vehicle_id)
        then raise exception using errcode='23P01',message='RENTAL_CONFLICT'; end if;
      insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,reason,created_by)
      values(booking.vehicle_id,booking.id,'Reserva',booking.starts_at,booking.ends_at,'Reserva confirmada',auth.uid());
      if booking.cleaning_minutes>0 then
        insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,reason,created_by)
        values(booking.vehicle_id,booking.id,'Limpieza',booking.ends_at,booking.ends_at+make_interval(mins=>booking.cleaning_minutes),'Limpieza prevista',auth.uid());
      end if;
      update public.reservations set status='Confirmada',version=version+1 where id=booking.id returning * into booking;
      result:=to_jsonb(booking);
    elsif command='cancel' then
      if booking.status='Cancelada' or booking.rental_state<>'Preparado' or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_CANCELLATION'; end if;
      update public.vehicle_commitments set active=false,reason=btrim(payload->>'reason') where reservation_id=booking.id;
      update public.reservations set status='Cancelada',version=version+1 where id=booking.id returning * into booking;
      result:=to_jsonb(booking); -- Never delete future charges, payments or evidence on cancellation.
    else
      if booking.status<>'Confirmada' or booking.rental_state not in ('Preparado','Entregado') then raise exception 'RESERVATION_NOT_EXTENDABLE'; end if;
      end_time:=(payload->>'endsAt')::timestamptz;
      if end_time is null or not isfinite(end_time) or end_time<=booking.ends_at or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_EXTENSION'; end if;
      if not exists(select 1 from public.rental_alternatives(booking.starts_at,end_time+make_interval(mins=>booking.cleaning_minutes),booking.id) where id=booking.vehicle_id)
        then raise exception using errcode='23P01',message='RENTAL_CONFLICT'; end if;
      update public.vehicle_commitments set active=false where reservation_id=booking.id;
      update public.vehicle_commitments set ends_at=end_time,reason=btrim(payload->>'reason'),active=true where reservation_id=booking.id and kind='Reserva';
      update public.vehicle_commitments set starts_at=end_time,ends_at=end_time+make_interval(mins=>booking.cleaning_minutes),active=true,
        reason=btrim(payload->>'reason') where reservation_id=booking.id and kind='Limpieza';
      update public.reservations set ends_at=end_time,total=daily_rate*greatest(1,ceil(extract(epoch from(end_time-starts_at))/86400)),
        version=version+1 where id=booking.id returning * into booking;
      result:=to_jsonb(booking);
    end if;
  elsif command='block' then
    if payload->>'kind' not in ('Taller','Limpieza') or nullif(btrim(payload->>'reason'),'') is null then raise exception 'INVALID_VEHICLE_BLOCK'; end if;
    insert into public.vehicle_commitments(vehicle_id,kind,starts_at,ends_at,reason,created_by)
    values((payload->>'vehicleId')::uuid,payload->>'kind',(payload->>'startsAt')::timestamptz,
      (payload->>'endsAt')::timestamptz,btrim(payload->>'reason'),auth.uid()) returning to_jsonb(vehicle_commitments.*) into result;
  elsif command='plan_workshop' then
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'BLOCK_REASON_REQUIRED'; end if;
    update public.vehicle_commitments set ends_at=(payload->>'endsAt')::timestamptz,reason=btrim(payload->>'reason')
      where order_id=payload->>'orderId' and kind='Taller' and exists(select 1 from public.work_orders where id=payload->>'orderId' and status<>'Entregado')
      returning to_jsonb(vehicle_commitments.*) into result;
    if result is null then raise exception 'OPEN_WORKSHOP_BLOCK_REQUIRED'; end if;
  else
    if nullif(btrim(payload->>'reason'),'') is null then raise exception 'BLOCK_REASON_REQUIRED'; end if;
    select * into car from public.vehicles where id=(select vehicle_id from public.vehicle_commitments where id=(payload->>'blockId')::uuid) for update;
    update public.vehicle_commitments set ends_at=clock_timestamp(),reason=btrim(payload->>'reason') where id=(payload->>'blockId')::uuid
      and order_id is null and kind in ('Limpieza','Taller') and starts_at<clock_timestamp() returning to_jsonb(vehicle_commitments.*) into result;
    if result is null then raise exception 'BLOCK_CANNOT_BE_FINISHED'; end if;
    if not exists(select 1 from public.work_orders where vehicle_id=car.id and status<>'Entregado')
      and not exists(select 1 from public.reservations where vehicle_id=car.id and rental_state='Entregado')
      and not exists(select 1 from public.vehicle_commitments where vehicle_id=car.id and active and kind<>'Reserva' and starts_at<=now() and ends_at>now()) then
      update public.vehicles set status='Disponible',readiness_hold=false,version=version+1 where id=car.id;
    end if;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;
revoke all on function public.rental_alternatives(timestamptz,timestamptz,uuid),public.execute_reservation_command(text,jsonb,uuid) from public,anon;
grant execute on function public.rental_alternatives(timestamptz,timestamptz,uuid),public.execute_reservation_command(text,jsonb,uuid) to authenticated;
