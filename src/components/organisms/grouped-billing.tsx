'use client';
import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {billingRpc,billingCommand,localToday,type CustomerPayment} from '@/lib/supabase/billing';
import type {Reservation} from '@/lib/supabase/reservations';
import {orderHref} from '@/lib/supabase/cases';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';

const emptyLine=()=>({operation:'',description:'',gross:'',discount:'0',discountReason:'',startsOn:'',endsOn:''});
export function GroupedDocumentForm({bookings,onChange}:{bookings:Reservation[];onChange:()=>Promise<void>}){
  const {data}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const [customerId,setCustomerId]=useState('');const [lines,setLines]=useState([emptyLine()]);
  return <details className="panel p-5 mb-5"><summary>Emitir un documento para varios vehículos / períodos</summary>
    <p className="inline-note mt-4">Un comprobante externo, un solo total. No vuelva a emitir cargos que ya existen.
      Las deducciones GPS se declaran por línea y necesitan autorización; no son pagos.</p>
    <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
      const payload={customerId,...Object.fromEntries(['description','externalReference','date','dueOn'].map(key=>[key,String(f.get(key)??'')])),
        lines:lines.map(line=>({...line,...(line.operation.startsWith('order:')?{orderId:line.operation.slice(6)}:{reservationId:line.operation.slice(8)}),
          startsOn:line.startsOn||null,endsOn:line.endsOn||null}))};
      void execute('billing.grouped',payload,key=>billingRpc('issue_grouped_document',{payload,idempotency_key:key}));
    }}><fieldset disabled={busy} className="contents">
      <label className="form-field"><span>Cliente del documento agrupado</span><select aria-label="Cliente del documento agrupado" required value={customerId} onChange={e=>{setCustomerId(e.target.value);setLines([emptyLine()]);}}>
        <option value="">Seleccionar cliente</option>{data.customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="form-field"><span>Referencia externa única (tipo, año y número)</span><input required name="externalReference" placeholder="CCF 2026 #069"/></label>
      <label className="form-field"><span>Concepto del documento agrupado</span><input required name="description"/></label>
      <div className="form-grid"><label className="form-field"><span>Emisión del documento agrupado</span><input required type="date" name="date" defaultValue={localToday()}/></label>
        <label className="form-field"><span>Vencimiento del documento agrupado</span><input required type="date" name="dueOn" defaultValue={localToday()}/></label></div>
      {lines.map((line,index)=><fieldset className="panel p-4" key={index}><legend>Línea {index+1}</legend>
        <label className="form-field"><span>Operación de línea {index+1}</span><select aria-label={`Operación de línea ${index+1}`} required value={line.operation} onChange={e=>setLines(lines.map((l,i)=>i===index?{...l,operation:e.target.value}:l))}>
          <option value="">Seleccionar operación del mismo cliente</option>{bookings.filter(r=>r.customer_id===customerId).map(r=><option key={r.id} value={`booking:${r.id}`}>{r.vehicle_snapshot.plate} · {folio('ALQ',r.folio_number)}</option>)}
          {data.orders.filter(o=>o.customerId===customerId&&!o.internalJob&&data.vehicles.find(v=>v.id===o.vehicleId)?.ownership!=='Propio').map(o=><option key={o.id} value={`order:${o.id}`}>{folio('OT',o.id)} · {o.service}</option>)}</select></label>
        <label className="form-field"><span>Descripción de línea {index+1}</span><input required value={line.description} onChange={e=>setLines(lines.map((l,i)=>i===index?{...l,description:e.target.value}:l))}/></label>
        <div className="form-grid">{(['gross','discount'] as const).map(key=><label className="form-field" key={key}><span>{key==='gross'?'Importe bruto':'Deducción autorizada'} USD · {index+1}</span>
          <input required type="number" step="0.01" min={key==='gross'?'0.01':'0'} value={line[key]} onChange={e=>setLines(lines.map((l,i)=>i===index?{...l,[key]:e.target.value}:l))}/></label>)}</div>
        <label className="form-field"><span>Motivo de deducción de línea {index+1}</span><input required={Number(line.discount)>0} value={line.discountReason} onChange={e=>setLines(lines.map((l,i)=>i===index?{...l,discountReason:e.target.value}:l))}/></label>
        {line.operation.startsWith('booking:')&&<div className="form-grid">{(['startsOn','endsOn'] as const).map(key=><label className="form-field" key={key}>
          <span>Período {key==='startsOn'?'desde':'hasta'} (opcional) · {index+1}</span><input type="date" value={line[key]} onChange={e=>setLines(lines.map((l,i)=>i===index?{...l,[key]:e.target.value}:l))}/></label>)}</div>}
        <Button type="button" variant="ghost" disabled={lines.length===1} onClick={()=>setLines(lines.filter((_,i)=>i!==index))}>Quitar línea {index+1}</Button>
      </fieldset>)}
      <Button type="button" variant="outline" disabled={lines.length>=200} onClick={()=>setLines([...lines,emptyLine()])}>Agregar vehículo / período al documento</Button>
      <p>Total neto propuesto: {money(lines.reduce((sum,l)=>sum+(Number(l.gross)||0)-(Number(l.discount)||0),0))}. El servidor vuelve a calcularlo.</p>
      <Button type="submit">Emitir un único documento desglosado</Button>
    </fieldset></form>{error&&<p role="alert" className="form-error">{error}</p>}
  </details>;
}

interface DocumentLine {id:string;order_id:string|null;reservation_id:string|null;description:string;gross:number;discount:number;discount_reason:string;amount:number;balance:number;starts_on:string|null;ends_on:string|null;}
export function GroupedDocumentActions({documentId,payments,onChange}:{documentId:string;payments:CustomerPayment[];onChange:()=>Promise<void>}){
  const {can}=useBusiness();const [lines,setLines]=useState<DocumentLine[]>([]);const [values,setValues]=useState<Record<string,string>>({});
  const [loadError,setLoadError]=useState('');const reload=useCallback(async()=>{
    setLines(await billingRpc('billing_line_positions',{document_id:documentId}));await onChange();
  },[documentId,onChange]);
  const {busy,error,execute}=useCaseAction(reload);
  useEffect(()=>{void billingRpc<DocumentLine[]>('billing_line_positions',{document_id:documentId}).then(setLines).catch(error=>setLoadError(error.message));},[documentId]);
  return <section className="mt-3"><p className="field-hint">Saldos de línea actuales; no cambian al consultar una fecha histórica de cartera.</p>
    {lines.map(line=><article className="inline-note mt-3" key={line.id}><strong>{line.description}</strong>
      <p>Bruto {money(line.gross)} − deducción {money(line.discount)} = {money(line.amount)} · Saldo {money(line.balance)}</p>
      {line.discount>0&&<p>{line.discount_reason}</p>}
      {line.order_id?<Link href={orderHref(line.order_id)}>{line.order_id} · Abrir pliego</Link>:
        <Link href={`/vehiculos/reservas/?reserva=${line.reservation_id}`}>Abrir alquiler</Link>}
      {line.starts_on&&<p>{line.starts_on} al {line.ends_on}</p>}
    </article>)}
    {can('expenses.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
      const allocations=lines.filter(l=>Number(values[l.id])>0).map(l=>({lineId:l.id,amount:values[l.id]}));
      const command=String(f.get('command')) as 'apply'|'refund'|'credit';
      const payload={documentId,paymentId:f.get('paymentId')||null,date:String(f.get('date')),reason:String(f.get('reason')),
        refundAccount:String(f.get('refundAccount')??''),amount:(allocations.reduce((sum,a)=>sum+Math.round(Number(a.amount)*100),0)/100).toFixed(2),allocations};
      void execute(`grouped.${command}`,payload,key=>billingCommand(command,payload,key)).then(saved=>{if(saved)setValues({});});
    }}><label className="form-field"><span>Acción del documento agrupado</span><select aria-label="Acción del documento agrupado" name="command"><option value="apply">Aplicar recibo existente</option><option value="refund">Reembolsar aplicación</option><option value="credit">Nota de crédito</option></select></label>
      <label className="form-field"><span>Recibo del mismo cliente</span><select aria-label="Recibo del mismo cliente" name="paymentId"><option value="">Sin recibo (nota de crédito)</option>
        {payments.map(p=><option value={p.id} key={p.id}>{p.reference} · {money(p.amount)}</option>)}</select></label>
      {lines.map(line=><label className="form-field" key={line.id}><span>Asignar USD a {line.description}</span><input type="number" step="0.01" min="0" value={values[line.id]??''} onChange={e=>setValues({...values,[line.id]:e.target.value})}/></label>)}
      <label className="form-field"><span>Fecha del reparto</span><input type="date" name="date" required defaultValue={localToday()}/></label>
      <label className="form-field"><span>Motivo del reparto</span><input name="reason" required/></label>
      <label className="form-field"><span>Cuenta de salida (solo reembolso)</span><input name="refundAccount"/></label>
      <Button type="submit" disabled={busy}>Confirmar importe repartido por línea</Button>
    </form>}{(error||loadError)&&<p role="alert" className="form-error">{error||loadError}</p>}
  </section>;
}
