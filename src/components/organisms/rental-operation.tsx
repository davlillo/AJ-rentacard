'use client';
import Link from 'next/link';
import {useState} from 'react';
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

export function RentalProgress({booking,commitments}:{booking:Reservation;commitments:Commitment[]}){
  const flow=rentalWorkflow(booking,commitments);
  return <div className="rental-progress"><Badge tone={flow.tone}>{flow.label}</Badge>
    {flow.step!==null&&<ol aria-label="Etapas del alquiler">{['Reserva','Alquilado','Devuelto','Limpieza revisada'].map((label,index)=>
      <li key={label} className={index<flow.step!?'complete':index===flow.step?'current':''} aria-current={index===flow.step?'step':undefined}>
        <span aria-hidden="true">{index<flow.step!||flow.step===3?<Check size={14}/>:index+1}</span><strong>{label}</strong></li>)}</ol>}
    <p>{flow.description}</p>
  </div>;
}

export function RentalDates({booking}:{booking:Reservation}){
  return <dl className="rental-dates"><div><dt>Entrega prevista</dt><dd>{rentalDateTime(booking.starts_at)}</dd></div>
    <div><dt>Devolución prevista</dt><dd>{booking.open_ended?'Sin fecha final definida':rentalDateTime(booking.ends_at)}</dd></div>
    {booking.actual_departure_at&&<div><dt>Entrega real</dt><dd>{rentalDateTime(booking.actual_departure_at)}</dd></div>}
    {booking.actual_return_at&&<div><dt>Devolución real</dt><dd>{rentalDateTime(booking.actual_return_at)}</dd></div>}</dl>;
}

export function RentalOperation({file,onChange,onSection,onConfirm,busy=false,title='Operación del alquiler'}:{
  file:CaseFile;onChange:()=>Promise<void>;onSection?:(section:RentalSection)=>void;onConfirm?:()=>void;busy?:boolean;title?:string;
}){
  const {can}=useBusiness();const [receipt,setReceipt]=useState(false);
  const booking=file.reservations[0];const flow=rentalWorkflow(booking,file.commitments);const amount=operationMoney(file);
  const payable=file.documents?.filter(d=>!d.grouped&&Number(d.scope_balance)>0)??[];
  const next=flow.action==='confirm'?{label:'Confirmar reserva',section:'Resumen' as const}:
    flow.action==='depart'?{label:'Preparar entrega',section:'Salida y devolución' as const}:
    flow.action==='return'?{label:'Registrar devolución',section:'Salida y devolución' as const}:
    flow.action==='clean'?{label:'Finalizar limpieza',section:'Limpieza' as const}:null;
  return <section className="panel rental-operation" aria-label={`${title} · ${folio('ALQ',booking.folio_number)}`}>
    <header><div><span className="section-kicker">{title}</span><h2>{folio('ALQ',booking.folio_number)} · {booking.customer_snapshot.name}</h2></div>
      {!onSection&&<Link className="text-link" href={rentalSectionHref(booking.id)}>Abrir alquiler <ArrowUpRight size={14}/></Link>}</header>
    <RentalProgress booking={booking} commitments={file.commitments}/>
    <RentalDates booking={booking}/><p className="rental-timezone">Horario de El Salvador (UTC−6)</p>
    {file.financialAccess&&<><dl className="operation-amounts rental-money"><div><dt>Cargos de este alquiler</dt><dd>{amount.charged?money(amount.charged):'Sin cargo emitido'}</dd></div>
      <div><dt>Abonos aplicados</dt><dd className="amount-paid">{money(amount.paid)}</dd></div>
      <div className="amount-outstanding"><dt>Por cobrar de este alquiler</dt><dd>{amount.charged?money(amount.balance):'Sin cargo emitido'}</dd></div></dl>
      {amount.advances>0&&<p className="rental-advance">Anticipo disponible: <strong>{money(amount.advances)}</strong>. Ya está recibido; puede aplicarlo a un cargo.</p>}</>}
    <div className="rental-actions">
      {next&&can('orders.write')&&(onSection?<Button disabled={busy} onClick={()=>{if(flow.action==='confirm'&&onConfirm)onConfirm();else onSection(next.section);}}><ClipboardCheck size={16}/>{next.label}</Button>:
        <Button asChild><Link href={rentalSectionHref(booking.id,next.section)}><ClipboardCheck size={16}/>{next.label}</Link></Button>)}
      {file.financialAccess&&can('expenses.write')&&(amount.balance>0&&payable.length>0||!amount.charged&&booking.status!=='Cancelada')&&
        <Button variant={next?'outline':'default'} onClick={()=>setReceipt(true)}><Wallet size={16}/>{amount.balance>0?`Cobrar saldo · ${money(amount.balance)}`:'Registrar anticipo'}</Button>}
      {file.financialAccess&&amount.balance>0&&!payable.length&&<Button asChild variant="outline"><Link href={`/cobros/?operacion=${encodeURIComponent(booking.id)}`}>Revisar cobro agrupado</Link></Button>}
      {file.financialAccess&&(onSection?<button className="text-link" onClick={()=>onSection('Cargos y abonos')}>Ver cargos y abonos →</button>:
        <Link className="text-link" href={rentalSectionHref(booking.id,'Cargos y abonos')}>Ver cargos y abonos →</Link>)}
    </div>
    {flow.action==='depart'&&<p className="rental-action-note"><CarFront size={15}/>La entrega requiere inspección, fechas vigentes y vehículo listo. Una reserva futura no inicia el alquiler.</p>}
    {flow.action==='return'&&<p className="rental-action-note">La devolución termina el uso del vehículo; no registra un pago ni elimina el saldo.</p>}
    {receipt&&<ReceiptDialog customerId={booking.customer_id} reservationId={booking.id}
      documentId={payable.length===1?payable[0].id:undefined} initialAmount={payable.length===1?Number(payable[0].scope_balance):undefined}
      revision={(file.documents??[]).map(d=>d.id+':'+d.scope_balance).join('|')+(file.advances??[]).map(p=>p.id+':'+p.available_amount).join('|')}
      onChange={onChange} onClose={()=>setReceipt(false)}/>}
  </section>;
}
