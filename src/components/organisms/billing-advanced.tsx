'use client';
import {useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {billingCommand,loadBilling,localToday,type BillingCommand,type Receivable,type CustomerPayment,type PaymentApplication,type PaymentRefund} from '@/lib/supabase/billing';
import {loadCalendar,type Reservation} from '@/lib/supabase/reservations';
import {PaymentImportPanel} from '@/components/organisms/payment-import';
import {GroupedDocumentForm,GroupedDocumentActions} from '@/components/organisms/grouped-billing';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {folio} from '@/controladores/folios';

export function AdvancedBilling({onChange}:{onChange?:()=>Promise<void>}){
  const {data,can,toast}=useBusiness();const [cutoff,setCutoff]=useState(localToday);const [documents,setDocuments]=useState<Receivable[]>([]);
  const [payments,setPayments]=useState<CustomerPayment[]>([]);const [applications,setApplications]=useState<PaymentApplication[]>([]);
  const [refunds,setRefunds]=useState<PaymentRefund[]>([]);const [bookings,setBookings]=useState<Reservation[]>([]);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  const page=usePagination(documents,cutoff);
  async function reload(){const loaded=await loadBilling(cutoff);setDocuments(loaded.documents);setPayments(loaded.payments);setApplications(loaded.applications);setRefunds(loaded.refunds);if(can('orders.read'))setBookings((await loadCalendar()).reservations);await onChange?.();}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[cutoff]);
  async function submit(command:BillingCommand,payload:Record<string,unknown>,form?:HTMLFormElement){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    try{await billingCommand(command,payload,attempt.current.key);await reload();form?.reset();toast('Movimiento y auditoría guardados. No se eliminaron saldos anteriores.');}
    catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  const history=(id:string)=>applications.filter(application=>application.document_id===id);
  const available=(payment:CustomerPayment)=>Number(payment.amount)-applications.filter(a=>a.payment_id===payment.id)
    .reduce((sum,a)=>sum+(a.kind==='Aplicacion'?1:-1)*Number(a.amount),0)-refunds.filter(r=>r.payment_id===payment.id).reduce((sum,r)=>sum+Number(r.amount),0);
  return <>
    {can('expenses.write')&&<PaymentImportPanel onPublished={reload}/>}
    {can('expenses.write')&&<GroupedDocumentForm bookings={bookings} onChange={reload}/>}
    <div className="panel p-5 mb-5"><label className="form-field"><span>Fecha de corte de cartera</span><input type="date" value={cutoff} onChange={event=>setCutoff(event.target.value)}/></label>
      <p className="mt-3">Saldo al corte: <strong>{money(documents.reduce((sum,d)=>sum+Number(d.balance),0))}</strong> · Vencido: <strong>{money(documents.filter(d=>d.days_overdue>0).reduce((sum,d)=>sum+Number(d.balance),0))}</strong></p>
    </div>
    {can('expenses.write')&&<div className="grid gap-5 xl:grid-cols-2 mb-5">
      <details className="panel p-5"><summary>Emitir cargo con vencimiento</summary><form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
        const operation=String(f.get('operation'));void submit('issue',{description:String(f.get('description')),amount:String(f.get('amount')),date:String(f.get('date')),dueOn:String(f.get('dueOn')),
          ...(operation.startsWith('order:')?{orderId:operation.slice(6)}:{reservationId:operation.slice(8)})},form);
      }}><label className="form-field"><span>Operación del cargo</span><select aria-label="Operación del cargo" name="operation" required>
        {bookings.map(r=><option value={`booking:${r.id}`} key={r.id}>{r.vehicle_snapshot.plate} · {r.customer_snapshot.name} · Alquiler</option>)}
        {data.orders.filter(order=>!order.internalJob&&data.vehicles.find(v=>v.id===order.vehicleId)?.ownership!=='Propio').map(o=><option key={o.id} value={`order:${o.id}`}>{folio('OT',o.id)} · {o.service}</option>)}
      </select></label><label className="form-field"><span>Concepto del cargo</span><input name="description" required/></label>
        <label className="form-field"><span>Importe del cargo (USD)</span><input name="amount" type="number" min="0.01" step="0.01" required/></label>
        <label className="form-field"><span>Fecha de emisión</span><input name="date" type="date" defaultValue={localToday()} required/></label>
        <label className="form-field"><span>Vencimiento del documento</span><input name="dueOn" type="date" defaultValue={localToday()} required/></label>
        <Button type="submit" disabled={busy}>Emitir cargo</Button>
      </form></details>
      <details className="panel p-5"><summary>Registrar recibo de cliente</summary><form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
        void submit('pay',Object.fromEntries(['customerId','amount','date','method','account','reference'].map(key=>[key,String(f.get(key))])),form);
      }}><label className="form-field"><span>Cliente del recibo</span><select aria-label="Cliente del recibo" name="customerId" required>{data.customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="form-field"><span>Importe del recibo (USD)</span><input name="amount" type="number" min="0.01" step="0.01" required/></label>
        <label className="form-field"><span>Fecha del recibo</span><input name="date" type="date" defaultValue={localToday()} required/></label>
        <label className="form-field"><span>Medio del recibo</span><select aria-label="Medio del recibo" name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
        <label className="form-field"><span>Cuenta del recibo</span><input name="account" required/></label>
        <label className="form-field"><span>Referencia del recibo</span><input name="reference" required/></label><Button type="submit" disabled={busy}>Guardar recibo</Button>
      </form></details>
    </div>}
    <section className="panel"><div className="table-scroll"><AdaptiveTable><thead><tr><th>Documento / operación</th><th>Vencimiento</th><th>Cargo / saldo</th><th>Aplicaciones e historial</th></tr></thead>
      <tbody>{page.items.map(document=><tr key={document.id}><td><span className="folio-link">{folio('CAR',document.folio_number)}</span><strong>{document.description}</strong><small>{document.customer_snapshot.name}</small>{document.external_reference&&<small>{document.external_reference}</small>}</td>
        <td>{document.due_on}<small>{document.aging_bucket} · {document.days_overdue} días</small></td><td>{money(document.amount)} / <strong>{money(document.balance)}</strong></td>
        <td><details><summary>Ver pagos y ajustes</summary>{history(document.id).map(a=><p key={a.id} className="mt-2">{a.kind} · {money(a.amount)} · {a.effective_on}<small>{a.reason}</small></p>)}
          {document.grouped?<GroupedDocumentActions documentId={document.id} payments={payments.filter(p=>p.customer_id===document.current_customer_id||p.customer_id===document.customer_id)} onChange={reload}/>:
          can('expenses.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void submit(String(f.get('command')) as BillingCommand,
            {documentId:document.id,paymentId:f.get('paymentId')||null,amount:String(f.get('amount')),date:String(f.get('date')),reason:String(f.get('reason')),refundAccount:String(f.get('refundAccount')??'')});
          }}><label className="form-field"><span>Acción sobre documento</span><select aria-label="Acción sobre documento" name="command"><option value="apply">Aplicar recibo</option><option value="refund">Reembolsar aplicación</option><option value="credit">Nota de crédito</option></select></label>
            <label className="form-field"><span>Recibo a aplicar o reembolsar</span><select aria-label="Recibo a aplicar o reembolsar" name="paymentId"><option value="">Sin recibo (nota de crédito)</option>
              {payments.filter(p=>p.customer_id===document.current_customer_id||p.customer_id===document.customer_id||data.customers.find(c=>c.id===document.current_customer_id)?.aliases?.some(alias=>'id' in alias&&alias.id===p.customer_id)).map(p=><option key={p.id} value={p.id}>{folio('REC',p.folio_number)} · {p.reference} · disponible {money(available(p))}</option>)}</select></label>
            <label className="form-field"><span>Importe de aplicación o ajuste</span><input name="amount" type="number" min="0.01" step="0.01" required/></label>
             <label className="form-field"><span>Fecha de aplicación o ajuste</span><input name="date" type="date" defaultValue={localToday()} required/></label>
             <label className="form-field"><span>Cuenta de salida (solo reembolso)</span><input name="refundAccount"/></label>
            <label className="form-field"><span>Motivo del ajuste</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Confirmar aplicación o ajuste</Button>
          </form>}
        </details></td></tr>)}</tbody></AdaptiveTable></div>{!documents.length&&<p className="p-5">No hay documentos emitidos al corte seleccionado.</p>}<Pagination {...page}/></section>
    <details className="panel p-5 mt-5"><summary className="font-semibold">Pagos recibidos</summary>{payments.map(p=><p key={p.id} className="mt-3"><span className="folio-link">{folio('REC',p.folio_number)}</span> · {p.reference} · {money(p.amount)} · disponible {money(available(p))}<small>{p.method} · {p.account} · {p.paid_on}</small></p>)}</details>
    {error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </>;
}
