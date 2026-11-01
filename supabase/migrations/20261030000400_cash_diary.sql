-- Cash diary is a read model over receipts/expenses, not a second posting ledger.
create table private.diary_functions(signature text primary key,definition text not null);
insert into private.diary_functions select s,pg_get_functiondef(s::regprocedure) from unnest(array[
  'public.execute_billing_command(text,jsonb,uuid)']) s;
create table public.cash_entries(
  id uuid primary key default gen_random_uuid(),kind text not null check(kind in ('Apertura','Transferencia','Ingreso no comercial','Salida no operativa')),
  date date not null check(isfinite(date)),account text not null check(length(btrim(account))>0),
  counter_account text,amount numeric(14,2) not null check(amount>=0 and amount::text not in ('NaN','Infinity')),
  concept text not null check(length(btrim(concept)) between 1 and 2000),reason text not null check(length(btrim(reason))>0),
  created_by uuid not null references auth.users,created_at timestamptz not null default now(),
  check(kind='Apertura' or amount>0),
  check((kind='Transferencia' and nullif(btrim(counter_account),'') is not null and account<>counter_account)
    or (kind<>'Transferencia' and counter_account is null))
);
create unique index cash_account_opening on public.cash_entries(account) where kind='Apertura';
alter table public.cash_entries enable row level security;
revoke all on public.cash_entries from anon,authenticated;
grant select on public.cash_entries to authenticated;
create policy cash_entry_read on public.cash_entries for select to authenticated using(public.has_permission('expenses.read'));
create trigger cash_entry_audit after insert on public.cash_entries for each row execute function private.audit_change();
create trigger cash_entry_immutable before update or delete on public.cash_entries for each row execute function private.immutable_quote_record();
alter table public.payment_refunds add column refund_account text not null default '';
create function private.capture_refund_account() returns trigger language plpgsql set search_path='' as $$
begin new.refund_account:=coalesce(nullif(btrim(current_setting('aj.refund_account',true)),''),'');return new;end $$;
create trigger refund_account_capture before insert on public.payment_refunds for each row execute function private.capture_refund_account();
create or replace function public.execute_billing_command(command text,payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text;previous_account text;begin
  previous:=current_setting('aj.billing_allocations',true);previous_account:=current_setting('aj.refund_account',true);
  perform set_config('aj.billing_allocations',coalesce((payload->'allocations')::text,''),true);
  perform set_config('aj.refund_account',coalesce(payload->>'refundAccount',''),true);
  result:=private.billing_command_before_grouped(command,payload,idempotency_key);
  perform set_config('aj.billing_allocations',coalesce(previous,''),true);
  perform set_config('aj.refund_account',coalesce(previous_account,''),true);return result;
end $$;
create function public.record_cash_entry(payload jsonb,idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.command_results;request jsonb:=jsonb_build_object('command','cash.entry','payload',payload);result jsonb;value numeric;
begin
  if not public.has_permission('expenses.write') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if payload->>'kind'='Apertura' and not exists(select 1 from public.user_roles where user_id=auth.uid() and role='owner') then raise exception 'OPENING_REQUIRES_MANAGEMENT';end if;
  if idempotency_key is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'INVALID_REQUEST';end if;
  perform pg_advisory_xact_lock(6192,1);
  select * into prior from private.command_results where actor=auth.uid() and key=idempotency_key;
  if found then if prior.request<>request then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.result;end if;
  value:=(payload->>'amount')::numeric;
  if value is null or value<>round(value,2) or (payload->>'date')::date>(now() at time zone 'America/El_Salvador')::date then raise exception 'INVALID_AMOUNT_DATE';end if;
  insert into public.cash_entries(kind,date,account,counter_account,amount,concept,reason,created_by)
  values(payload->>'kind',(payload->>'date')::date,btrim(payload->>'account'),nullif(btrim(payload->>'counterAccount'),''),value,
    btrim(payload->>'concept'),btrim(payload->>'reason'),auth.uid()) returning to_jsonb(cash_entries.*) into result;
  insert into private.command_results values(auth.uid(),idempotency_key,request,result);return result;
end $$;
revoke all on function public.record_cash_entry(jsonb,uuid) from public,anon;
grant execute on function public.record_cash_entry(jsonb,uuid) to authenticated;
create function private.diary_sources() returns table(id text,date date,kind text,concept text,amount numeric,account text,counter_account text,area text,destination text,source_type text)
language sql stable set search_path='' as $$
  select 'expense:'||e.id,e.date,'Egreso',e.concept,e.amount,e.account,null,
    case when e.operation_id is not null or e.cost_center_id='workshop' then 'Taller'
      when e.vehicle_id is not null or e.reservation_id is not null or e.cost_center_id='rental' then 'Renta' else 'Administración' end,
    coalesce(e.operation_id,e.reservation_id::text,e.vehicle_id::text,e.cost_center_id),'expense'
  from public.expenses e
  union all select 'receipt:'||p.id,p.paid_on,'Ingreso','Recibo de cliente: '||p.reference,p.amount,p.account,null,'Por aplicación',p.customer_id::text,'receipt' from public.customer_payments p
  union all select 'refund:'||r.id,r.refunded_on,'Egreso','Reembolso: '||r.reason,r.amount,nullif(r.refund_account,''),null,'Por aplicación',r.payment_id::text,'refund' from public.payment_refunds r
  union all select 'cash:'||c.id,c.date,c.kind,c.concept,c.amount,c.account,c.counter_account,'Tesorería',c.reason,'cash' from public.cash_entries c;
$$;
create function public.cash_diary(from_date date,to_date date,account_filter text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;opening public.cash_entries;before_balance numeric;net numeric;income numeric;outgoing numeric;unassigned integer;
begin
  if not public.has_permission('expenses.read') then raise exception using errcode='42501',message='PERMISSION_DENIED';end if;
  if from_date is null or to_date is null or not isfinite(from_date) or not isfinite(to_date) or to_date<from_date then raise exception 'INVALID_DIARY_RANGE';end if;
  if (select count(*) from private.diary_sources() s where s.date between from_date and to_date)>10000 then raise exception 'NARROW_DIARY_RANGE';end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.date,r.id),'[]'),coalesce(sum(r.inflow),0),coalesce(sum(r.outflow),0),coalesce(sum(r.balance_effect),0)
    into rows,income,outgoing,net from (
    select s.*,case when s.kind='Ingreso' or s.kind='Ingreso no comercial' or (s.kind='Transferencia' and s.counter_account=account_filter) then s.amount else 0 end inflow,
      case when s.kind in ('Egreso','Salida no operativa') or (s.kind='Transferencia' and s.account=account_filter) then s.amount else 0 end outflow,
      case when s.kind='Apertura' then 0 when s.kind in ('Ingreso','Ingreso no comercial') then s.amount
        when s.kind in ('Egreso','Salida no operativa') then -s.amount when s.kind='Transferencia' and s.counter_account=account_filter then s.amount
        when s.kind='Transferencia' and s.account=account_filter then -s.amount else 0 end balance_effect
    from private.diary_sources() s where s.date between from_date and to_date
      and (account_filter is null or account_filter in (s.account,s.counter_account))
  ) r;
  select count(*) into unassigned from private.diary_sources() s where s.date<=to_date and s.account is null;
  if account_filter is not null then
    select * into opening from public.cash_entries c where c.kind='Apertura' and c.account=account_filter and c.date<=from_date;
    if opening.id is not null and unassigned=0 then
      select opening.amount+coalesce(sum(case when s.kind in ('Ingreso','Ingreso no comercial') then s.amount
        when s.kind in ('Egreso','Salida no operativa') then -s.amount when s.kind='Transferencia' and s.counter_account=account_filter then s.amount
        when s.kind='Transferencia' and s.account=account_filter then -s.amount else 0 end),0) into before_balance
      from private.diary_sources() s where s.date>=opening.date and s.date<from_date and account_filter in(s.account,s.counter_account);
    end if;
  end if;
  return jsonb_build_object('rows',rows,'income',income,'outgoing',outgoing,'netMovement',net,'balanceBefore',before_balance,
    'balanceAfter',case when before_balance is not null then before_balance+net else null end,
    'hasOpening',opening.id is not null,'unassignedRefunds',unassigned,'opening',to_jsonb(opening),
    'accounts',coalesce((select jsonb_agg(a.account order by a.account) from (select distinct s.account from private.diary_sources() s where s.account is not null
      union select distinct s.counter_account from private.diary_sources() s where s.counter_account is not null) a),'[]'),
    'policy','cash-events-once-v1; documents-and-applications-are-not-cash; unknown-refund-accounts-remain-unassigned');
end $$;
revoke all on function public.cash_diary(date,date,text) from public,anon;
grant execute on function public.cash_diary(date,date,text) to authenticated;
