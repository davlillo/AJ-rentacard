-- HU17: frozen departure/return inspections and proposed extras, never automatic charges.
create table public.rental_inspections (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations,
  kind text not null check(kind in ('Salida','Retorno')),
  km integer not null check(km>=0),
  fuel numeric(5,2) not null check(fuel between 0 and 100 and fuel::text not in ('NaN','Infinity')),
  condition text not null check(length(btrim(condition))>0),
  accessories text not null,
  evidence text not null check(length(btrim(evidence))>0),
  created_by uuid not null references auth.users,
  occurred_at timestamptz not null default clock_timestamp(),
  unique(reservation_id,kind)
);
create table public.rental_extra_proposals (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations,
  description text not null,
  comparison jsonb not null,
  amount numeric(14,2) check(amount>0 and amount::text not in ('NaN','Infinity')),
  status text not null default 'Propuesto' check(status in ('Propuesto','Aprobado','Rechazado')),
  reason text not null default 'Diferencia detectada en inspección',
  version integer not null default 1,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
alter table public.rental_inspections enable row level security;
alter table public.rental_extra_proposals enable row level security;
revoke all on public.rental_inspections,public.rental_extra_proposals from anon,authenticated;
grant select on public.rental_inspections,public.rental_extra_proposals to authenticated;
create policy inspection_read on public.rental_inspections for select to authenticated using(public.has_permission('orders.read'));
create policy rental_extra_read on public.rental_extra_proposals for select to authenticated using(public.has_permission('orders.read'));
create trigger inspection_audit after insert on public.rental_inspections for each row execute function private.audit_change();
create trigger inspection_immutable before update or delete on public.rental_inspections for each row execute function private.immutable_quote_record();
create trigger rental_extra_audit after insert or update on public.rental_extra_proposals for each row execute function private.audit_change();

create function public.execute_rental_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  prior private.command_results;
  request jsonb:=jsonb_build_object('command','rental.'||command,'payload',payload);
  booking public.reservations;
  car public.vehicles;
  outgoing public.rental_inspections;
  incoming public.rental_inspections;
  proposal public.rental_extra_proposals;
  clean_start timestamptz;
  clean_end timestamptz;
  conflict boolean:=false;
  result jsonb;
begin
  if not public.has_permission('orders.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
  if command is null or command not in ('depart','return','decide_extra') or idempotency_key is null
    or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_RENTAL_COMMAND'; end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then
    if prior.request<>request then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT'; end if;
    return prior.result;
  end if;
  if command='decide_extra' then
    if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED'; end if;
    select * into proposal from public.rental_extra_proposals where id=(payload->>'proposalId')::uuid for update;
    if proposal.id is null or proposal.status<>'Propuesto' then raise exception 'EXTRA_NOT_PENDING'; end if;
    if (payload->>'expectedVersion')::integer is distinct from proposal.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    if payload->>'decision' not in ('Aprobado','Rechazado') or nullif(btrim(payload->>'reason'),'') is null then raise exception 'EXTRA_DECISION_REQUIRED'; end if;
    if payload->>'decision'='Aprobado' and (payload->>'amount')::numeric is null then raise exception 'EXTRA_AMOUNT_REQUIRED'; end if;
    update public.rental_extra_proposals set status=payload->>'decision',amount=(payload->>'amount')::numeric,
      reason=btrim(payload->>'reason'),version=version+1 where id=proposal.id returning * into proposal;
    result:=to_jsonb(proposal);
  else
    select * into booking from public.reservations where id=(payload->>'reservationId')::uuid for update;
    if booking.id is null or booking.status<>'Confirmada' then raise exception 'CONFIRMED_RESERVATION_REQUIRED'; end if;
    if (payload->>'expectedVersion')::integer is distinct from booking.version then raise exception using errcode='23505',message='VERSION_CONFLICT'; end if;
    select * into car from public.vehicles where id=booking.vehicle_id for update;
    if command='depart' then
      if booking.rental_state<>'Preparado' or car.status<>'Disponible' or car.readiness_hold or now()<booking.starts_at or now()>=booking.ends_at
        then raise exception 'RENTAL_NOT_READY_FOR_DEPARTURE'; end if;
      if (payload->>'km')::integer<car.km then raise exception 'ODOMETER_CANNOT_DECREASE'; end if;
      insert into public.rental_inspections(reservation_id,kind,km,fuel,condition,accessories,evidence,created_by)
      values(booking.id,'Salida',(payload->>'km')::integer,(payload->>'fuel')::numeric,btrim(payload->>'condition'),
        btrim(payload->>'accessories'),btrim(payload->>'evidence'),auth.uid()) returning * into outgoing;
      update public.reservations set rental_state='Entregado',version=version+1 where id=booking.id returning * into booking;
      update public.vehicles set status='Alquilado',km=outgoing.km,version=version+1 where id=car.id;
      result:=jsonb_build_object('reservation',to_jsonb(booking),'inspection',to_jsonb(outgoing));
    else
      if booking.rental_state<>'Entregado' then raise exception 'RENTAL_NOT_OUT'; end if;
      select * into outgoing from public.rental_inspections where reservation_id=booking.id and kind='Salida';
      if (payload->>'km')::integer<outgoing.km then raise exception 'ODOMETER_CANNOT_DECREASE'; end if;
      insert into public.rental_inspections(reservation_id,kind,km,fuel,condition,accessories,evidence,created_by)
      values(booking.id,'Retorno',(payload->>'km')::integer,(payload->>'fuel')::numeric,btrim(payload->>'condition'),
        btrim(payload->>'accessories'),btrim(payload->>'evidence'),auth.uid()) returning * into incoming;
      if incoming.condition<>outgoing.condition or incoming.accessories<>outgoing.accessories or incoming.fuel<outgoing.fuel then
        insert into public.rental_extra_proposals(reservation_id,description,comparison,created_by)
        values(booking.id,'Diferencias de condición, accesorios o combustible por revisar',
          jsonb_build_object('departure',to_jsonb(outgoing),'return',to_jsonb(incoming)),auth.uid());
      end if;
      update public.reservations set rental_state='Devuelto',version=version+1 where id=booking.id returning * into booking;
      update public.vehicles set status='En taller',readiness_hold=true,km=incoming.km,version=version+1 where id=car.id;
      clean_start:=greatest(clock_timestamp(),booking.ends_at);clean_end:=clean_start+greatest(interval '1 second',make_interval(mins=>booking.cleaning_minutes));
      update public.vehicle_commitments set active=false where reservation_id=booking.id and kind='Limpieza';
      insert into public.vehicle_commitments(vehicle_id,reservation_id,kind,starts_at,ends_at,active,reason,created_by)
      values(car.id,booking.id,'Limpieza',clean_start,clean_end,false,'Revisión posterior a devolución',auth.uid())
      on conflict(reservation_id,kind) where reservation_id is not null do update set starts_at=excluded.starts_at,ends_at=excluded.ends_at,reason=excluded.reason;
      begin
        update public.vehicle_commitments set active=true where reservation_id=booking.id and kind='Limpieza';
      exception when exclusion_violation then
        conflict:=true;
        update public.vehicle_commitments set reason='CONFLICTO de limpieza tras devolución tardía; requiere reprogramación' where reservation_id=booking.id and kind='Limpieza';
      end;
      result:=jsonb_build_object('reservation',to_jsonb(booking),'departure',to_jsonb(outgoing),'return',to_jsonb(incoming),'cleaningConflict',conflict);
    end if;
  end if;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);
  return result;
end;
$$;
revoke all on function public.execute_rental_command(text,jsonb,uuid) from public,anon;
grant execute on function public.execute_rental_command(text,jsonb,uuid) to authenticated;
