'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {useBusiness} from '@/hooks/use-business';
import {costCommand,loadCosts,loadPurchasePayments,payDirectPurchase,type WorkshopCost,type DirectPurchasePayment} from '@/lib/supabase/workshop';
import {loadEstimates,type QuoteVersion} from '@/lib/supabase/estimates';
import {AdaptiveTable} from './adaptive-table';
import {folio} from '@/controladores/folios';
import {diaryHref} from '@/controladores/linked-money';
import {ExpenseInbox} from './linked-expense';

export function WorkshopCosts({orderId,onChange}:{orderId:string;onChange?:()=>Promise<void>}){
  const {data,toast,can,refresh,open,modal}=useBusiness();const [costs,setCosts]=useState<WorkshopCost[]>([]);
  const [payments,setPayments]=useState<DirectPurchasePayment[]>([]);
  const afterDelivery=data.orders.find(order=>order.id===orderId)?.status==='Entregado';
  const [quotes,setQuotes]=useState<QuoteVersion[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const attempt=useRef<{body:string;key:string}|null>(null);const sending=useRef(false);
  const loadRevision=useRef(0);
  async function reload(){const revision=++loadRevision.current;const [nextCosts,nextPayments,nextQuotes]=await Promise.all([
    loadCosts(orderId),loadPurchasePayments(orderId),can('expenses.write')?loadEstimates().then(result=>result.quotes.filter(quote=>quote.order_id===orderId&&quote.status==='Aprobado')):Promise.resolve([])]);
    if(revision===loadRevision.current){setCosts(nextCosts);setPayments(nextPayments);setQuotes(nextQuotes);}}
  useEffect(()=>{void reload().catch(error=>setError(error.message));return()=>{loadRevision.current++;};},[orderId,modal.kind,data.movements.length]);
  async function submit(command:'purchase'|'classify',payload:Record<string,unknown>,form?:HTMLFormElement){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    try{await costCommand(command,payload,attempt.current.key,afterDelivery);await reload();await onChange?.();form?.reset();toast('Costo guardado con su destino. No se generó un cobro automático.');}
    catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  async function pay(costId:string,payload:Record<string,unknown>,form:HTMLFormElement){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command:'pay',costId,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    try{await payDirectPurchase(costId,payload,attempt.current.key);await reload();form.reset();
      await refresh().catch(()=>toast('Pago confirmado. Actualice el diario para ver el movimiento.'));await onChange?.();
      attempt.current=null;
      toast('Pago guardado. El costo de la compra no cambió.');
    }catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  return <section aria-label={`Costos de ${orderId}`}>
    <p className="inline-note">Compra directa registra costo real, no pago de caja ni cargo al cliente. Los gastos del diario se vinculan una sola vez.
      Cada costo inicia pendiente de disposición comercial.</p>
    <div className="case-money-links"><Button variant="outline" disabled={!can('expenses.write')} onClick={()=>open('gasto',orderId)}>Registrar gasto de este trabajo</Button>
      <Link href={`/presupuestos/?trabajo=${encodeURIComponent(orderId)}`}>Revisar presupuesto y adicionales →</Link>
      <Link href={diaryHref(orderId)}>Ver movimientos originales en diario →</Link></div>
    {can('expenses.write')&&<ExpenseInbox orderId={orderId} onChange={async()=>{await reload();await onChange?.();}}/>}
    {afterDelivery&&<p className="inline-note mt-4">Orden entregada: solo gerencia puede registrar ajustes con motivo. El acta original no cambia.</p>}
    {can('expenses.write')&&<details className="mt-4"><summary>Registrar compra directa inesperada</summary>
      <form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
        void submit('purchase',{orderId,...Object.fromEntries(['description','quantity','unitCost','supplier','sourceReference','date','reason'].map(key=>[key,String(f.get(key)??'')]))},form);}}>
        <label className="form-field"><span>Repuesto o servicio adquirido</span><input name="description" required maxLength={2000}/></label>
        <div className="form-grid"><label className="form-field"><span>Cantidad adquirida</span><input name="quantity" required type="number" min="0.0001" step="0.0001" defaultValue="1"/></label>
          <label className="form-field"><span>Costo unitario real (USD)</span><input name="unitCost" required type="number" min="0.0001" step="0.0001"/></label></div>
        <label className="form-field"><span>Proveedor de compra</span><input name="supplier" required/></label>
        <label className="form-field"><span>Referencia de factura y línea</span><input name="sourceReference" required/></label>
        <label className="form-field"><span>Fecha de compra</span><input name="date" type="date" required defaultValue={new Date().toLocaleDateString('en-CA')}/></label>
        {afterDelivery&&<label className="form-field"><span>Motivo del ajuste posterior</span><textarea name="reason" required/></label>}
        <Button type="submit" disabled={busy}>Asignar compra a {orderId}</Button>
      </form></details>}
    <p className="mt-4 font-semibold">Costo real total: {money(costs.reduce((sum,cost)=>sum+Number(cost.amount),0))}</p>
    <div className="table-scroll mt-4"><AdaptiveTable><thead><tr><th>Costo y origen</th><th>Importe</th><th>Disposición comercial</th></tr></thead>
      <tbody>{costs.map(cost=>{const paid=payments.filter(payment=>payment.direct_purchase_cost_id===cost.id).reduce((sum,payment)=>sum+Number(payment.amount),0);
        const pending=Math.round((Number(cost.amount)-paid)*100)/100;
          return <tr key={cost.id}><td><strong>{cost.description}</strong><small>{cost.kind} · {cost.expense_id??cost.linked_expense_id??`${cost.supplier} / ${cost.source_reference}`}</small>
          <small>{cost.occurred_at}</small>{(cost.expense_id||cost.linked_expense_id)&&<Link className="text-link" href={diaryHref(orderId,'expense:'+(cost.expense_id??cost.linked_expense_id),cost.occurred_at)}>Ver gasto original →</Link>}</td>
          <td>{money(cost.amount)}{cost.linked_expense_id&&<small>Importe asignado a este trabajo</small>}</td><td><strong>{cost.disposition==='Pendiente'?'Por revisar si está incluido o es adicional':cost.disposition}</strong><small>{cost.reason}</small>
        {can('expenses.write')&&<details><summary>Clasificar costo</summary><form className="operation-form" onSubmit={event=>{
          event.preventDefault();const f=new FormData(event.currentTarget);void submit('classify',{costId:cost.id,expectedVersion:cost.version,
            disposition:String(f.get('disposition')),estimateId:f.get('estimateId')||null,reason:String(f.get('reason'))});
        }}><label className="form-field"><span>Disposición de {cost.description}</span><select aria-label={`Disposición de ${cost.description}`} name="disposition" defaultValue={cost.disposition==='Pendiente'?'Interno':cost.disposition}>
          <option>Incluido</option><option>Adicional autorizado</option><option>Interno</option><option>Absorbido</option></select></label>
          <label className="form-field"><span>Alcance aprobado de {cost.description}</span><select aria-label={`Alcance aprobado de ${cost.description}`} name="estimateId" defaultValue={cost.estimate_id??''}>
            <option value="">No aplica a interno/absorbido</option>{quotes.map(quote=><option key={quote.id} value={quote.id}>{folio('PRE',quote.folio_number)} · Versión {quote.revision}</option>)}</select></label>
          <label className="form-field"><span>Motivo de disposición de {cost.description}</span><input name="reason" required/></label>
          <Button type="submit" variant="outline" disabled={busy}>Guardar disposición</Button>
        </form></details>}
        {cost.kind==='Compra directa'&&<><p>Pagado: {money(paid)} · Pendiente: {money(pending)}</p>
          {payments.filter(payment=>payment.direct_purchase_cost_id===cost.id).map(payment=><small key={payment.id}>{payment.id} · {payment.date} · {money(payment.amount)}</small>)}
          {can('expenses.write')&&pending>0&&<details><summary>Pagar compra directa</summary>
            <form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
              void pay(cost.id,Object.fromEntries(['amount','date','method','account'].map(key=>[key,String(f.get(key)??'')])),form);}}>
              <label className="form-field"><span>Importe a pagar de {cost.description}</span><input name="amount" type="number" min="0.01" max={pending} step="0.01" required/></label>
              <label className="form-field"><span>Fecha del pago de {cost.description}</span><input name="date" type="date" min={cost.occurred_at} required defaultValue={new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date())}/></label>
              <label className="form-field"><span>Medio del pago de {cost.description}</span><select name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
              <label className="form-field"><span>Cuenta del pago de {cost.description}</span><input name="account" required/></label>
              <Button variant="outline" type="submit" disabled={busy}>Guardar pago sin duplicar costo</Button>
            </form></details>}</>}
        </td></tr>;})}</tbody></AdaptiveTable></div>
    {!costs.length&&<p className="p-4">Sin costos registrados para esta orden.</p>}
    {error&&<p role="alert" className="form-error">{error}</p>}
  </section>;
}
