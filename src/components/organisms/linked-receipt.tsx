'use client';
import {useEffect,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {money} from '@/controladores/finanzas';
import {paymentAvailable,rentalLabel,workLabel} from '@/controladores/linked-money';
import {loadBilling,localToday,type Receivable,type CustomerPayment,type PaymentApplication,type PaymentRefund} from '@/lib/supabase/billing';
import {recordLinkedReceipt} from '@/lib/supabase/connected-money';
import {folio} from '@/controladores/folios';
import {MoneyOperationSelect} from './money-operation-select';
import styles from './money-workspace.module.css';

interface ReceiptProps {
  customerId?:string;orderId?:string;reservationId?:string;paymentId?:string;
  onChange:()=>Promise<void>;onSaved?:()=>void;onBusyChange?:(busy:boolean)=>void;revision?:string;
}
export function ReceiptForm({customerId:initialCustomer,orderId,reservationId,paymentId:initialPayment,onChange,onSaved,onBusyChange,revision}:ReceiptProps){
  const {data,refresh}=useBusiness();
  const [customerId,setCustomerId]=useState(initialCustomer??'');
  const [operation,setOperation]=useState(orderId?'order:'+orderId:reservationId?'reservation:'+reservationId:'');
  const [paymentId,setPaymentId]=useState(initialPayment??'');const [target,setTarget]=useState('choose');const [amount,setAmount]=useState('');
  const [records,setRecords]=useState<{documents:Receivable[];payments:CustomerPayment[];applications:PaymentApplication[];refunds:PaymentRefund[]}>();
  const [loadError,setLoadError]=useState('');const [loading,setLoading]=useState(true);
  const {busy,error,execute}=useCaseAction(async()=>{await refresh();await onChange();});
  useEffect(()=>{onBusyChange?.(busy);},[busy,onBusyChange]);
  async function reload(){setLoading(true);try{setRecords(await loadBilling(localToday()));setLoadError('');}finally{setLoading(false);}}
  useEffect(()=>{let active=true;setLoading(true);void loadBilling(localToday()).then(result=>{if(active){setRecords(result);setLoadError('');setLoading(false);}})
    .catch(error=>{if(active){setLoadError(error.message);setLoading(false);}});return()=>{active=false;};},[revision]);
  const customer=data.customers.find(c=>c.id===customerId);
  const belongs=(id:string)=>id===customerId||!!customer?.aliases?.some(alias=>'id' in alias&&alias.id===id);
  const scopedOrder=operation.startsWith('order:')?operation.slice(6):undefined;
  const scopedRental=operation.startsWith('reservation:')?operation.slice(12):undefined;
  const documents=records?.documents.filter(d=>belongs(d.current_customer_id??d.customer_id)&&!d.grouped&&Number(d.balance)>0&&
    (!scopedOrder||d.order_id===scopedOrder)&&(!scopedRental||d.reservation_id===scopedRental))??[];
  const availablePayments=records?.payments.filter(p=>belongs(p.customer_id)&&paymentAvailable(p,records.applications,records.refunds)>0)??[];
  const document=documents.find(d=>d.id===target);const selectedPayment=availablePayments.find(p=>p.id===paymentId);
  const maximum=Math.min(document?Number(document.balance):Infinity,selectedPayment&&records?paymentAvailable(selectedPayment,records.applications,records.refunds):Infinity);
  return <section className={styles.receipt} aria-label="Cobro o anticipo vinculado"><h3>{paymentId?'Aplicar dinero ya recibido':'Registrar cobro o anticipo'}</h3>
    <p>Un recibo entra una sola vez en el diario. Aplicar un recibo existente reduce la deuda, pero no registra otro ingreso.</p>
    {loading&&<p role="status">Consultando cargos y recibos…</p>}
    {loadError&&<><p role="alert" className="form-error">{loadError}</p><Button variant="outline" onClick={()=>{void reload().catch(e=>setLoadError(e.message));}}>Reintentar consulta</Button></>}
    <form className="operation-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);
      const payload={customerId,amount,date:String(f.get('date')),
        ...(scopedOrder?{orderId:scopedOrder}:scopedRental?{reservationId:scopedRental}:{}),
        ...(target!=='advance'?{documentId:target}:{}),...(paymentId?{paymentId}:{method:String(f.get('method')),account:String(f.get('account')),reference:String(f.get('reference'))})};
      void execute('money.receipt',payload,key=>recordLinkedReceipt(payload,key)).then(async saved=>{
        if(saved){setAmount('');if(onSaved)onSaved();else{setTarget('choose');await reload().catch(e=>setLoadError(e.message));}}
      });
    }}><fieldset disabled={busy||loading||!!loadError} className={styles.fieldset}>
      {initialCustomer?<div className={styles.context}><strong>{customer?.name??'Cliente del trabajo'}</strong>
        {orderId?workLabel(data,orderId):reservationId?rentalLabel(data,reservationId):'Recibos del cliente'}</div>:
        <label className="form-field"><span>Cliente del cobro</span><select aria-label="Cliente del cobro" required value={customerId} onChange={event=>{
          setCustomerId(event.target.value);setOperation('');setPaymentId('');setTarget('choose');
        }}><option value="">Seleccionar cliente</option>{data.customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
      {!orderId&&!reservationId&&<MoneyOperationSelect label="Folio de taller o contrato del cobro (opcional)"
        emptyLabel="Sin folio / contrato — anticipo general del cliente o elegir solo el cargo" customerId={customerId}
        value={operation} onChange={value=>{setOperation(value);setTarget('choose');}}/>}
      <label className="form-field"><span>Origen del dinero</span><select aria-label="Origen del dinero" value={paymentId} onChange={event=>{setPaymentId(event.target.value);setTarget('choose');}}>
        <option value="">Recibir un pago nuevo</option>{availablePayments.map(p=><option key={p.id} value={p.id}>
          Usar {folio('REC',p.folio_number)} · {p.reference} · disponible {money(paymentAvailable(p,records!.applications,records!.refunds))}</option>)}</select></label>
      <label className="form-field"><span>Destino del abono</span><select aria-label="Destino del abono" required value={target} onChange={event=>setTarget(event.target.value)}>
        <option value="choose" disabled>Seleccionar cargo o guardar como anticipo</option>
        {!paymentId&&<option value="advance">Anticipo — todavía sin aplicar a un cargo</option>}
        {documents.map(d=><option key={d.id} value={d.id}>{folio('CAR',d.folio_number)} · {d.description} · saldo {money(d.balance)}</option>)}</select></label>
      {!documents.length&&customerId&&<p className="inline-note">No hay cargos individuales con saldo en esta vista. Puede registrar un anticipo sin inventar deuda.
        Los documentos agrupados se gestionan en Cargos y cobros → Importaciones, documentos agrupados y otros ajustes.</p>}
      {target==='advance'&&<p className={styles.receiptNotice}>El dinero queda recibido y disponible para aplicar después. No se marca el trabajo como pagado ni se crea un cargo.</p>}
      {!!paymentId&&<p className={styles.receiptNotice}>Este recibo ya está en caja. La aplicación no volverá a sumar dinero al diario.</p>}
      <div className="form-grid"><label className="form-field"><span>Importe del abono (USD)</span><input required type="number" min="0.01" step="0.01"
        max={Number.isFinite(maximum)?maximum:undefined} value={amount} onChange={event=>setAmount(event.target.value)}/></label>
        <label className="form-field"><span>{paymentId?'Fecha de aplicación':'Fecha del cobro'}</span><input name="date" type="date" required max={localToday()} defaultValue={localToday()}/></label></div>
      {!paymentId&&<><div className="form-grid"><label className="form-field"><span>Medio de pago</span><select aria-label="Medio de pago" name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
        <label className="form-field"><span>Cuenta o caja receptora</span><input name="account" required/></label></div>
        <label className="form-field"><span>Referencia del pago</span><input name="reference" required/></label></>}
      {error&&<p role="alert" className="form-error">{error}</p>}
      <Button type="submit" disabled={!customerId||target==='choose'||(!!paymentId&&!document)}>{busy?'Guardando…':paymentId?'Aplicar recibo sin nuevo ingreso':target==='advance'?'Guardar anticipo vinculado':'Guardar cobro y aplicar al cargo'}</Button>
    </fieldset></form>
  </section>;
}
export function ReceiptDialog({onClose,...props}:ReceiptProps&{onClose:()=>void}){
  const [busy,setBusy]=useState(false);
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent closeDisabled={busy} className={styles.dialog}>
    <DialogTitle className="text-xl font-semibold">Cobros y anticipos</DialogTitle>
    <DialogDescription className="text-sm text-muted-foreground mt-2">El mismo recibo, vinculado al cliente y a su operación.</DialogDescription>
    <ReceiptForm {...props} onSaved={onClose} onBusyChange={setBusy}/>
  </DialogContent></Dialog>;
}
