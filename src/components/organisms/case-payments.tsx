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
import {WorkshopCollections} from './workshop-collections';

type CasePaymentsProps={file:CaseFile;job?:CaseOrder;reservationId?:string;onChange:()=>Promise<void>;workshopContext?:boolean};
export function CasePayments(props:CasePaymentsProps){
  return props.workshopContext?<WorkshopCollections {...props}/>:<LegacyCasePayments {...props}/>;
}
function LegacyCasePayments({file,job,reservationId,onChange,workshopContext=false}:CasePaymentsProps){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const customerId=job?.customer_id??file.reservations.find(r=>r.id===reservationId)?.customer_id;
  const inconsistentWorkshop=!!job&&!job.internal_job&&file.vehicle.ownership==='Propio';
   if(workshopContext&&(!file.financialAccess||!can('expenses.read')))return <p className="inline-note">Información financiera restringida.</p>;
   // The rental wording stays exactly as it was; the workshop wording names the same facts
   // in the operator's terms and never mixes the two vocabularies.
   const inconsistentNotice=workshopContext
    ?'El vehículo figura como propio de AJ, pero el trabajo tiene cliente. Revise el tipo de ingreso antes de emitir importes a cobrar. No se ha reclasificado el expediente.'
    :'El vehículo figura como propio de AJ, pero el trabajo tiene cliente. Revise el tipo de ingreso antes de emitir cargos. No se ha reclasificado el expediente.';
   return <section><p className="inline-note">{workshopContext?
     'El importe facturado al cliente, el cobro recibido y el cobro aplicado son hechos distintos. El presupuesto es el precio al cliente, no el costo interno. Un anticipo disponible ya fue recibido: aplicarlo no registra dinero nuevo.':
     'Cargo, recibo de caja y aplicación son hechos distintos.'} Aquí se muestra únicamente el importe vinculado a este expediente, no toda la deuda del cliente.</p>
    {inconsistentWorkshop&&<p className="inline-note mt-4">{inconsistentNotice}</p>}
    {job&&!job.internal_job&&!inconsistentWorkshop&&can('expenses.write')&&<form className="operation-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);void execute('bill_scope',{
        orderId:job.id,date:String(f.get('date')),dueOn:String(f.get('dueOn'))});
     }}><h3 className="font-semibold">{workshopContext?'Emitir importe a cobrar del alcance aprobado que falta facturar':'Emitir cargo del alcance aprobado aún no facturado'}</h3>
       <div className="form-grid"><label className="form-field"><span>{workshopContext?'Fecha de emisión':'Fecha del cargo'}</span><input type="date" name="date" required defaultValue={localToday()}/></label>
         <label className="form-field"><span>{workshopContext?'Fecha de vencimiento':'Vencimiento del cargo'}</span><input type="date" name="dueOn" required defaultValue={localToday()}/></label></div>
      <Button type="submit" disabled={busy}>Emitir solamente la diferencia pendiente</Button></form>}
     <div className="table-scroll mt-4"><AdaptiveTable><thead><tr><th>Documento</th><th>Fecha / vencimiento</th><th>{workshopContext?'Importe facturado al cliente':'Cargo de este expediente'}</th><th>{workshopContext?'Saldo pendiente':'Saldo'}</th></tr></thead>
      <tbody>{(file.documents??[]).map(d=><tr key={d.id}><td><span className="folio-link">{folio('CAR',d.folio_number)}</span>{d.description}</td><td>{d.issued_on} / {d.due_on}</td>
        <td>{money(d.scope_amount)}</td><td>{money(d.scope_balance)}</td></tr>)}</tbody></AdaptiveTable></div>
    {file.documents?.some(d=>d.grouped)&&<p className="inline-note mt-4"><Link href="/cobros">Este expediente participa en documentos agrupados. Reparta recibos y ajustes por línea {workshopContext?'en Cobros':'en Cartera'}.</Link></p>}
    {!!file.advances?.length&&<div className={styles.advances}>{file.advances.map(p=><div key={p.id}>
      <strong>{folio('REC',p.folio_number)} · Anticipo disponible: {money(p.available_amount)}</strong>
       <p>{p.paid_on} · {p.reference}. {workshopContext?'Importe disponible de este recibo ya recibido; no es un ingreso nuevo.':'Recibo original: '+money(p.amount)+'.'} {workshopContext?'Todavía no reduce lo pendiente de cobro de este trabajo.':'Todavía no reduce un cargo de este trabajo.'}</p>
      <Link className={styles.sourceLink} href={diaryHref(job?.id??reservationId,'receipt:'+p.id,p.paid_on)}>Ver el recibo original en diario →</Link>
    </div>)}</div>}
    {customerId&&!job?.internal_job&&(!inconsistentWorkshop||!!file.documents?.length)&&can('expenses.write')&&<ReceiptForm key={customerId+String(job?.id??reservationId)}
      customerId={customerId} orderId={job?.id} reservationId={reservationId} onChange={onChange}
      revision={(file.documents??[]).map(d=>d.id+':'+d.scope_balance).join('|')+(file.advances??[]).map(p=>p.id+':'+p.available_amount).join('|')}/>}
     <h3 className="mt-5 font-semibold">{workshopContext?'Cobros aplicados y reversiones':'Cobros aplicados'}</h3>
    {(file.applications??[]).map(a=><p className="inline-note mt-3" key={a.id}>{a.effective_on} · {a.kind} · {money(a.scope_amount)} · {a.reason}
      <br/><Link className={styles.sourceLink} href={diaryHref(job?.id??reservationId,'receipt:'+a.payment_id,
        file.payments?.find(p=>p.id===a.payment_id)?.paid_on)}>Ver recibo en diario →</Link></p>)}
    {job?.internal_job&&<p className="mt-4">Mantenimiento interno: no se genera cuenta por cobrar a AJ.</p>}
    {error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </section>;
}
