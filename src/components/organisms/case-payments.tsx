'use client';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {caseRpc,type CaseFile,type CaseOrder} from '@/lib/supabase/cases';
import {localToday} from '@/lib/supabase/billing';
import {money} from '@/controladores/finanzas';
import {AdaptiveTable} from './adaptive-table';
import {folio} from '@/controladores/folios';

export function CasePayments({file,job,reservationId,onChange}:{file:CaseFile;job?:CaseOrder;reservationId?:string;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
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
    {(reservationId||(job&&!job.internal_job))&&can('expenses.write')&&!!file.documents?.some(d=>d.scope_balance>0&&!d.grouped)&&<form className="operation-form" onSubmit={event=>{
      event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
      const payload={...(job?{orderId:job.id}:{}),...Object.fromEntries(['documentId','amount','date','method','account','reference'].map(key=>[key,String(f.get(key)??'')]))};
      void execute('collect',payload,reservationId?key=>caseRpc('collect_document',{payload,idempotency_key:key}):undefined)
        .then(saved=>{if(saved)form.reset();});
    }}><h3 className="font-semibold">Registrar abono nuevo y aplicarlo al documento elegido</h3>
      <label className="form-field"><span>Documento que recibe el abono</span><select aria-label="Documento que recibe el abono" name="documentId" required>
        {file.documents.filter(d=>d.scope_balance>0&&!d.grouped).map(d=><option key={d.id} value={d.id}>{d.description} · {money(d.scope_balance)}</option>)}</select></label>
      <div className="form-grid"><label className="form-field"><span>Abono USD</span><input name="amount" required type="number" min="0.01" step="0.01"/></label>
        <label className="form-field"><span>Fecha del abono</span><input name="date" required type="date" defaultValue={localToday()}/></label></div>
      <label className="form-field"><span>Medio del abono</span><select aria-label="Medio del abono" name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
      <label className="form-field"><span>Cuenta o caja receptora</span><input name="account" required/></label>
      <label className="form-field"><span>Referencia del recibo</span><input name="reference" required/></label>
      <Button type="submit" disabled={busy}>Guardar un recibo y su aplicación</Button>
    </form>}
    <h3 className="mt-5 font-semibold">Aplicaciones de cobros</h3>
    {(file.applications??[]).map(a=><p className="inline-note mt-3" key={a.id}>{a.effective_on} · {a.kind} · {money(a.scope_amount)} · {a.reason}</p>)}
    {job?.internal_job&&<p className="mt-4">Mantenimiento interno: no se genera cuenta por cobrar a AJ.</p>}
    {error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </section>;
}
