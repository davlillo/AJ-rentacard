'use client';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {type CaseFile,type CaseOrder} from '@/lib/supabase/cases';
import {localToday} from '@/lib/supabase/billing';
import {money} from '@/controladores/finanzas';
import {AdaptiveTable} from './adaptive-table';
import {folio} from '@/controladores/folios';
import {diaryHref} from '@/controladores/linked-money';
import {ReceiptForm} from './linked-receipt';
import styles from './money-workspace.module.css';

export function CasePayments({file,job,reservationId,onChange}:{file:CaseFile;job?:CaseOrder;reservationId?:string;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const customerId=job?.customer_id??file.reservations.find(r=>r.id===reservationId)?.customer_id;
  return <section><p className="inline-note">Cargo, recibo de caja y aplicación son hechos distintos. Aquí se muestra únicamente
    el importe vinculado a este expediente, no toda la deuda del cliente.</p>
    {job&&!job.internal_job&&can('expenses.write')&&<form className="operation-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);void execute('bill_scope',{
        orderId:job.id,date:String(f.get('date')),dueOn:String(f.get('dueOn'))});
    }}><h3 className="font-semibold">Emitir cargo del alcance aprobado aún no facturado</h3>
      <div className="form-grid"><label className="form-field"><span>Fecha del cargo</span><input type="date" name="date" required defaultValue={localToday()}/></label>
        <label className="form-field"><span>Vencimiento del cargo</span><input type="date" name="dueOn" required defaultValue={localToday()}/></label></div>
      <Button type="submit" disabled={busy}>Emitir solamente la diferencia pendiente</Button></form>}
    <div className="table-scroll mt-4"><AdaptiveTable><thead><tr><th>Documento</th><th>Fecha / vencimiento</th><th>Cargo de este expediente</th><th>Saldo</th></tr></thead>
      <tbody>{(file.documents??[]).map(d=><tr key={d.id}><td><span className="folio-link">{folio('CAR',d.folio_number)}</span>{d.description}</td><td>{d.issued_on} / {d.due_on}</td>
        <td>{money(d.scope_amount)}</td><td>{money(d.scope_balance)}</td></tr>)}</tbody></AdaptiveTable></div>
    {file.documents?.some(d=>d.grouped)&&<p className="inline-note mt-4"><Link href="/cobros">Este expediente participa en documentos agrupados. Reparta recibos y ajustes por línea en Cartera.</Link></p>}
    {!!file.advances?.length&&<div className={styles.advances}>{file.advances.map(p=><div key={p.id}>
      <strong>{folio('REC',p.folio_number)} · Anticipo disponible: {money(p.available_amount)}</strong>
      <p>{p.paid_on} · {p.reference}. Recibo original: {money(p.amount)}. Todavía no reduce un cargo de este trabajo.</p>
      <Link className={styles.sourceLink} href={diaryHref(job?.id??reservationId,'receipt:'+p.id,p.paid_on)}>Ver el recibo original en diario →</Link>
    </div>)}</div>}
    {customerId&&!job?.internal_job&&can('expenses.write')&&<ReceiptForm key={customerId+String(job?.id??reservationId)}
      customerId={customerId} orderId={job?.id} reservationId={reservationId} onChange={onChange}
      revision={(file.documents??[]).map(d=>d.id+':'+d.scope_balance).join('|')+(file.advances??[]).map(p=>p.id+':'+p.available_amount).join('|')}/>}
    <h3 className="mt-5 font-semibold">Aplicaciones de cobros</h3>
    {(file.applications??[]).map(a=><p className="inline-note mt-3" key={a.id}>{a.effective_on} · {a.kind} · {money(a.scope_amount)} · {a.reason}
      <br/><Link className={styles.sourceLink} href={diaryHref(job?.id??reservationId,'receipt:'+a.payment_id,
        file.payments?.find(p=>p.id===a.payment_id)?.paid_on)}>Ver recibo en diario →</Link></p>)}
    {job?.internal_job&&<p className="mt-4">Mantenimiento interno: no se genera cuenta por cobrar a AJ.</p>}
    {error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </section>;
}
