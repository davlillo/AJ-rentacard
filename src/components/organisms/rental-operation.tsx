'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {Check,Wallet,CarFront,ClipboardCheck,ArrowUpRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {useBusiness} from '@/hooks/use-business';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {operationMoney} from '@/controladores/operation-money';
import {rentalWorkflow,rentalDateTime,rentalSectionHref,type RentalSection} from '@/controladores/rental-workflow';
import type {Reservation,Commitment} from '@/lib/supabase/reservations';
import type {CaseFile} from '@/lib/supabase/cases';
import {ReceiptDialog} from './linked-receipt';
import {rentalElapsed,rentalAccounts,rentalLifecycle,rentalMoneyEvidence,rentalPendingSentence} from '@/controladores/rental-lifecycle';

export function RentalProgress({booking,commitments}:{booking:Reservation;commitments:Commitment[]}){
  const flow=rentalWorkflow(booking,commitments);
  const progress=rentalLifecycle(booking,flow);
  // The compact journey mirrors the folio stages: the same derived step and the same words.
  const labels=['Reserva','Alquilado','Devolución','Cuentas','Finalizado'];
  const compact=[0,0,1,2,3,4];
  const current=progress.currentIndex===null?null:compact[progress.currentIndex];
  return <div className="rental-progress"><Badge tone={flow.tone}>{flow.label}</Badge>
    {current!==null&&<ol aria-label="Etapas del alquiler">{labels.map((label,index)=>
      <li key={label} className={index<current?'complete':index===current?'current':''} aria-current={index===current?'step':undefined}>
        <span aria-hidden="true">{index<current?<Check size={14}/>:index+1}</span><strong>{label}</strong></li>)}
    </ol>}
    <p>{flow.description}</p>
  </div>;
}

export function RentalDates({booking}:{booking:Reservation}){
  return <dl className="rental-dates"><div><dt>Entrega prevista</dt><dd>{rentalDateTime(booking.starts_at)}</dd></div>
    <div><dt>Devolución prevista</dt><dd>{booking.open_ended?'Sin fecha final definida':rentalDateTime(booking.ends_at)}</dd></div>
    {booking.actual_departure_at&&<div><dt>Entrega real</dt><dd>{rentalDateTime(booking.actual_departure_at)}</dd></div>}
    {booking.actual_return_at&&<div><dt>Devolución real</dt><dd>{rentalDateTime(booking.actual_return_at)}</dd></div>}</dl>;
}

export function RentalOperation({file,onSection,onConfirm,onFinish,busy=false,title='Operación del alquiler'}:{
  file:CaseFile;onChange:()=>Promise<void>;onSection?:(section:RentalSection)=>void;onConfirm?:()=>void;onFinish?:()=>void;busy?:boolean;title?:string;
}){
  const {can}=useBusiness();
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(timer);},[]);
  const booking=file.reservations[0];const flow=rentalWorkflow(booking,file.commitments);const amount=operationMoney(file);
  // The same canonical facts the Cuentas section uses: agreed, emitted, applied and pending.
  const accounts=rentalAccounts(rentalMoneyEvidence(file,booking,null));
  const elapsed=rentalElapsed(booking,now);
  const next=flow.action==='confirm'?{label:'Confirmar reserva',section:'Resumen' as const}:
    flow.action==='depart'?{label:'Entregar vehículo',section:'Salida y devolución' as const}:
    flow.action==='return'?{label:'Terminar alquiler',section:'Salida y devolución' as const}:null;
  return <section className="panel rental-operation" aria-label={`${title} · ${folio('ALQ',booking.folio_number)}`}>
    <header><div><span className="section-kicker">{title}</span><h2>{folio('ALQ',booking.folio_number)} · {booking.customer_snapshot.name}</h2></div>
      {!onSection&&<Link className="text-link" href={rentalSectionHref(booking.id)}>Abrir alquiler <ArrowUpRight size={14}/></Link>}</header>
    <Badge tone={flow.tone}>{flow.label}</Badge>
    <RentalDates booking={booking}/><p className="rental-timezone">Horario de El Salvador (UTC−6)</p>
    {booking.status==='Confirmada'&&booking.rental_state!=='Preparado'&&<section className="inline-note mt-4" aria-label="Tiempo del alquiler">
      <h3 className="font-semibold">{elapsed.day===null?'Tiempo por revisar':`Día ${elapsed.day}${elapsed.plannedDays===null?'':` de ${elapsed.plannedDays}`}`}</h3>
      <p>{booking.open_ended?'Sin fecha final acordada. ':''}{elapsed.overdue?'Devolución prevista vencida. ':''}
        {elapsed.frozen?'Cálculo detenido en la devolución real. ':''}{elapsed.basis==='scheduled'?'Referencia: entrega prevista; falta hora real. ':''}
        {elapsed.estimate===null?'Estimación no disponible.':`Acumulado estimado: ${money(elapsed.estimate)}.`}</p>
      <p>Estimación por períodos de 24 horas redondeados hacia arriba. NO es un importe a cobrar ni un pago recibido; no modifica el acuerdo.</p>
    </section>}
    {file.financialAccess&&can('expenses.read')&&<><dl className="operation-amounts rental-money">
      <div><dt>Lo acordado</dt><dd>{accounts?.agreed==null?'Sin total acordado':money(accounts.agreed)}</dd>
        <small>Es lo pactado con el cliente por este alquiler.</small></div>
      <div><dt>Importes emitidos al cliente</dt><dd>{money(accounts?.charged??0)}</dd>
        <small>Documentos de cobro ya emitidos al cliente.</small></div>
      <div><dt>Cobros aplicados</dt><dd className="amount-paid">{money(accounts?.paid??0)}</dd>
        <small>Dinero ya recibido y aplicado a los importes emitidos.</small></div>
      <div className="amount-outstanding"><dt>Lo pendiente</dt><dd>{money(accounts?.pending??0)}</dd>
        <small>{accounts?rentalPendingSentence(accounts):'Información financiera restringida: no hay importes que mostrar.'}</small></div>
      </dl>
      {accounts&&accounts.pendingToEmit>0&&<p className="rental-advance">Falta emitir el documento de cobro por <strong>{money(accounts.pendingToEmit)}</strong>.
        {onSection?<button className="text-link" onClick={()=>onSection('Cuentas')}>Emitir importe a cobrar →</button>:
          <Link className="text-link" href={rentalSectionHref(booking.id,'Cuentas')}>Emitir importe a cobrar →</Link>}</p>}
      {amount.advances>0&&<p className="rental-advance">Anticipo disponible: <strong>{money(amount.advances)}</strong>. Ya está recibido; puede aplicarlo a los importes emitidos.</p>}</>}
    <div className="rental-actions">
      {next&&can('orders.write')&&(onSection?<Button disabled={busy} onClick={()=>{if(flow.action==='confirm'&&onConfirm)onConfirm();else if(flow.action==='return'&&onFinish)onFinish();else onSection(next.section);}}><ClipboardCheck size={16}/>{next.label}</Button>:
        <Button asChild><Link href={rentalSectionHref(booking.id,next.section)}><ClipboardCheck size={16}/>{next.label}</Link></Button>)}
      {file.financialAccess&&can('expenses.read')&&(onSection?<button className="text-link" onClick={()=>onSection('Cuentas')}>Ver cobros →</button>:
        <Link className="text-link" href={rentalSectionHref(booking.id,'Cuentas')}>Ver cobros →</Link>)}
    </div>
    {flow.action==='depart'&&<p className="rental-action-note"><CarFront size={15}/>La entrega requiere inspección, fechas vigentes y vehículo listo. Una reserva futura no inicia el alquiler.</p>}
    {flow.action==='return'&&<p className="rental-action-note">La devolución termina el uso del vehículo; no registra un pago ni elimina el saldo.</p>}
    {flow.action==='clean'&&<p className="rental-action-note"><CarFront size={15}/>El vehículo ya fue devuelto. Confirme la entrega y la liberación en este folio, en la etapa Devolución o en el Cierre del alquiler.</p>}
  </section>;
}

// Mounted once by the folio, outside every phase/secondary section. Unmount on
// permission loss to discard sensitive dialog state instead of hiding cached data.
export function RentalCollection({file,onChange}:{file:CaseFile;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const [receipt,setReceipt]=useState(false);
  const booking=file.reservations[0];
  const payable=file.documents?.filter(d=>!d.grouped&&Number(d.scope_balance)>0)??[];
  if(!file.financialAccess||!can('expenses.read')||!can('expenses.write'))return null;
  return <><Button variant="outline" onClick={()=>setReceipt(true)}><Wallet size={16}/>Realizar cobro</Button>
    {receipt&&<ReceiptDialog customerId={booking.customer_id} reservationId={booking.id}
      documentId={payable.length===1?payable[0].id:undefined} initialAmount={payable.length===1?Number(payable[0].scope_balance):undefined}
      revision={(file.documents??[]).map(d=>d.id+':'+d.scope_balance).join('|')+(file.advances??[]).map(p=>p.id+':'+p.available_amount).join('|')}
      staleGuard
      onChange={onChange} onClose={()=>setReceipt(false)}/>}
    {file.documents?.some(d=>d.grouped&&Number(d.scope_balance)>0)&&<Link className="text-link" href={`/cobros/?operacion=${encodeURIComponent(booking.id)}`}>Revisar cobro agrupado</Link>}
  </>;
}
