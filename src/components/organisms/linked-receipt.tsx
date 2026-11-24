'use client';
import {useEffect,useRef,useState} from 'react';
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
  customerId?:string;orderId?:string;reservationId?:string;paymentId?:string;documentId?:string;initialAmount?:number;
  onChange:()=>Promise<void>;onSaved?:()=>void;onBusyChange?:(busy:boolean)=>void;revision?:string;
  presentation?:'standalone'|'embedded';
  // A guarded form blocks the submission when the amounts changed under it, even without a workshop scope.
  staleGuard?:boolean;
  workshopContext?:{
    mode:'new'|'existing';
    documents:{id:string;balance:number}[];
    advanceIds:string[];
  };
}
export function ReceiptForm(props:ReceiptProps){
  const {can}=useBusiness();
  if(props.workshopContext&&!can('expenses.read'))return <p className="inline-note">Información financiera restringida.</p>;
  return <ReceiptEditor {...props}/>;
}
function ReceiptEditor({customerId:initialCustomer,orderId,reservationId,paymentId:initialPayment,documentId,initialAmount,onChange,onSaved,onBusyChange,revision,presentation='standalone',workshopContext,staleGuard}:ReceiptProps){
  const {data,refresh}=useBusiness();
  const [customerId,setCustomerId]=useState(initialCustomer??'');
  const [operation,setOperation]=useState(orderId?'order:'+orderId:reservationId?'reservation:'+reservationId:'');
  const [paymentId,setPaymentId]=useState(initialPayment??'');const [target,setTarget]=useState(documentId??(workshopContext?.mode==='new'&&!workshopContext.documents.length?'advance':'choose'));const [amount,setAmount]=useState(initialAmount?.toFixed(2)??'');
  const [records,setRecords]=useState<{documents:Receivable[];payments:CustomerPayment[];applications:PaymentApplication[];refunds:PaymentRefund[]}>();
  const [loadError,setLoadError]=useState('');const [loading,setLoading]=useState(true);
  const [intentRevision,setIntentRevision]=useState(revision);
  const [recordsRevision,setRecordsRevision]=useState<string>();
  const loadGeneration=useRef(0);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  // The stale guard protects the amounts under review: a workshop scope always guards its own form.
  const guarded=!!workshopContext||!!staleGuard;
  const stale=guarded&&intentRevision!==revision;
  const {busy,error,execute}=useCaseAction(async()=>{await refresh();await onChange();});
  useEffect(()=>{onBusyChange?.(busy);},[busy,onBusyChange]);
  useEffect(()=>()=>{onBusyChange?.(false);},[onBusyChange]);
  async function reload(){
    const generation=++loadGeneration.current;setLoading(true);
    try{const result=await loadBilling(localToday());if(alive.current&&generation===loadGeneration.current){setRecords(result);setRecordsRevision(revision);setLoadError('');}}
    catch(error){if(alive.current&&generation===loadGeneration.current)throw error;}
    finally{if(alive.current&&generation===loadGeneration.current)setLoading(false);}
  }
  useEffect(()=>{let active=true;const generation=++loadGeneration.current;setLoading(true);void loadBilling(localToday()).then(result=>{if(active&&generation===loadGeneration.current){setRecords(result);setRecordsRevision(revision);setLoadError('');setLoading(false);}})
    .catch(error=>{if(active&&generation===loadGeneration.current){setLoadError(error.message);setLoading(false);}});return()=>{active=false;};},[revision]);
  const customer=data.customers.find(c=>c.id===customerId);
  const belongs=(id:string)=>id===customerId||!!customer?.aliases?.some(alias=>'id' in alias&&alias.id===id);
  const scopedOrder=operation.startsWith('order:')?operation.slice(6):undefined;
  const scopedRental=operation.startsWith('reservation:')?operation.slice(12):undefined;
  const currentRecords=!guarded||recordsRevision===revision?records:undefined;
  const documents=currentRecords?.documents.filter(d=>belongs(d.current_customer_id??d.customer_id)&&!d.grouped&&Number(d.balance)>0&&
    (!scopedOrder||d.order_id===scopedOrder)&&(!scopedRental||d.reservation_id===scopedRental)&&
    (!workshopContext||workshopContext.documents.some(document=>document.id===d.id)))
    .map(document=>workshopContext?{...document,balance:Math.min(Number(document.balance),workshopContext.documents.find(scoped=>scoped.id===document.id)!.balance)}:document)??[];
  const availablePayments=currentRecords?.payments.filter(p=>belongs(p.customer_id)&&paymentAvailable(p,currentRecords.applications,currentRecords.refunds)>0&&
    (!workshopContext||workshopContext.advanceIds.includes(p.id)))??[];
  const document=documents.find(d=>d.id===target);const selectedPayment=availablePayments.find(p=>p.id===paymentId);
  const maximum=Math.min(document?Number(document.balance):Infinity,selectedPayment&&records?paymentAvailable(selectedPayment,records.applications,records.refunds):Infinity);
  return <section className={presentation==='embedded'?styles.receiptEmbedded:styles.receipt} aria-label="Cobro o anticipo vinculado">
    {presentation==='standalone'&&<><h3>{paymentId?'Aplicar dinero ya recibido':'Registrar cobro o anticipo'}</h3>
      <p>Un recibo entra una sola vez en el diario. Aplicar uno existente no registra otro ingreso.</p></>}
    {loading&&<p role="status">Consultando documentos y recibos…</p>}
    {loadError&&<><p role="alert" className="form-error">{loadError}</p><Button variant="outline" onClick={()=>{void reload().catch(e=>setLoadError(e.message));}}>Reintentar consulta</Button></>}
    {workshopContext&&<p>{workshopContext.mode==='new'?'Registra dinero que ya recibiste del cliente. Indica su fecha, medio y destino.':'Este dinero ya fue recibido. Aplicarlo no registra otro ingreso.'}</p>}
    {stale&&<p role="alert">Los importes o movimientos cambiaron. Se conservaron los campos; revise el saldo y el destino antes de continuar.
      <Button variant="outline" disabled={loading||!!loadError||recordsRevision!==revision} onClick={()=>setIntentRevision(revision)}>Revisé los saldos actualizados</Button></p>}
    <form className="operation-form" onSubmit={event=>{
      event.preventDefault();if(guarded&&(stale||recordsRevision!==revision||
        (workshopContext?.mode==='existing'&&!selectedPayment)||(workshopContext?.mode==='new'&&!!paymentId)))return;
      const f=new FormData(event.currentTarget);
      const payload={customerId,amount,date:String(f.get('date')),
        ...(scopedOrder?{orderId:scopedOrder}:scopedRental?{reservationId:scopedRental}:{}),
        ...(target!=='advance'?{documentId:target}:{}),...(paymentId?{paymentId}:{method:String(f.get('method')),account:String(f.get('account')),reference:String(f.get('reference'))})};
      void execute('money.receipt',payload,key=>recordLinkedReceipt(payload,key)).then(async saved=>{
        if(saved&&alive.current){setAmount('');if(onSaved)onSaved();else{setTarget('choose');await reload().catch(e=>setLoadError(e.message));}}
      });
    }}><fieldset disabled={busy||loading||!!loadError} className={styles.fieldset}>
      {initialCustomer?<div className={styles.context}>
       {orderId?workLabel(data,orderId):reservationId?rentalLabel(data,reservationId):customer?.name??'Recibos del cliente'}
       {workshopContext&&<p>Cliente: {customer?.name??initialCustomer}</p>}</div>:
        <label className="form-field"><span>Cliente del cobro</span><select aria-label="Cliente del cobro" required value={customerId} onChange={event=>{
          setCustomerId(event.target.value);setOperation('');setPaymentId('');setTarget('choose');
        }}><option value="">Seleccionar cliente</option>{data.customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
      {!orderId&&!reservationId&&<MoneyOperationSelect label="Folio de taller o contrato del cobro (opcional)"
        emptyLabel="Sin folio / contrato" customerId={customerId}
        value={operation} onChange={value=>{setOperation(value);setTarget('choose');}}/>}
      <div className={styles.receiptPair}>{(!workshopContext||workshopContext.mode==='existing')&&<label className="form-field"><span>Origen del dinero</span><select aria-label="Origen del dinero" value={paymentId} onChange={event=>{setPaymentId(event.target.value);setTarget('choose');}}>
        <option value="">{workshopContext?'Seleccionar anticipo disponible':'Recibir un pago nuevo'}</option>{availablePayments.map(p=><option key={p.id} value={p.id}>
          Usar {folio('REC',p.folio_number)} · {p.reference} · disponible {money(paymentAvailable(p,records!.applications,records!.refunds))}</option>)}</select>
          {selectedPayment&&<small className="selected-option-description">{folio('REC',selectedPayment.folio_number)} · {selectedPayment.reference} · disponible {money(paymentAvailable(selectedPayment,records!.applications,records!.refunds))}
            {workshopContext&&<> · Recibido el {selectedPayment.paid_on}</>}</small>}</label>}
      <label className="form-field"><span>A qué documento se aplica el cobro</span><select aria-label="A qué documento se aplica el cobro" required value={target} onChange={event=>setTarget(event.target.value)}>
        <option value="choose" disabled>Elija el documento a cobrar</option>
        {!paymentId&&workshopContext?.mode!=='existing'&&<option value="advance">Anticipo recibido · todavía sin aplicar</option>}
        {documents.map(d=><option key={d.id} value={d.id}>{folio('CAR',d.folio_number)} · {d.description} · saldo {money(d.balance)}</option>)}</select>
        {document&&<small className="selected-option-description">{folio('CAR',document.folio_number)} · {document.description} · saldo {money(document.balance)}</small>}</label></div>
      {!loading&&!loadError&&!documents.length&&customerId&&<p className="inline-note">No hay documentos de cobro con saldo en esta vista. Puede registrar un anticipo sin inventar deuda.
        Los documentos agrupados se gestionan en Cobros → Importaciones, documentos agrupados y otros ajustes.</p>}
      {target==='advance'&&<p className={styles.receiptNotice}>El dinero queda recibido y disponible para aplicar después. No se marca el trabajo como pagado ni se crea una deuda.</p>}
      {!!paymentId&&<p className={styles.receiptNotice}>Este recibo ya está en caja. La aplicación no volverá a sumar dinero al diario.</p>}
      <div className="form-grid"><label className="form-field"><span>Importe recibido (USD)</span><input required type="number" min="0.01" step="0.01"
        max={Number.isFinite(maximum)?maximum:undefined} value={amount} onChange={event=>setAmount(event.target.value)}/></label>
        <label className="form-field"><span>{paymentId||workshopContext?.mode==='existing'?'Fecha de aplicación':'Fecha del cobro'}</span><input name="date" type="date" required max={localToday()} defaultValue={localToday()}/></label></div>
      {!paymentId&&workshopContext?.mode!=='existing'&&<><div className="form-grid"><label className="form-field"><span>Medio de pago</span><select aria-label="Medio de pago" name="method" required={!!workshopContext}><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
        <label className="form-field"><span>Cuenta o caja receptora</span><input name="account" required/></label></div>
        <label className="form-field"><span>Referencia del pago</span><input name="reference" required/></label></>}
      {error&&<p role="alert" className="form-error">{error}</p>}
      {workshopContext&&document&&<p className={styles.receiptNotice}>Saldo de este trabajo en {folio('CAR',document.folio_number)}: {money(document.balance)}
        {Number(amount)>0&&Number(amount)<=maximum&&<> · Después de aplicar: {money(Number(document.balance)-Number(amount))}</>}</p>}
      <Button type="submit" disabled={!customerId||target==='choose'||(target!=='advance'&&!document)||stale||
        (guarded&&(recordsRevision!==revision||(workshopContext?.mode==='existing'&&!selectedPayment)))}>{busy?'Guardando…':
          workshopContext?(paymentId?`Aplicar ${money(Number(amount)||0)} sin nuevo ingreso`:target==='advance'?`Registrar anticipo de ${money(Number(amount)||0)}`:`Registrar cobro de ${money(Number(amount)||0)}`):
          paymentId?'Aplicar recibo sin nuevo ingreso':target==='advance'?'Guardar anticipo vinculado':'Guardar cobro y aplicar al documento'}</Button>
    </fieldset></form>
  </section>;
}
export function ReceiptDialog({onClose,...props}:ReceiptProps&{onClose:()=>void}){
  const [busy,setBusy]=useState(false);
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent closeDisabled={busy} className={styles.dialog}>
    <DialogTitle className="text-xl font-semibold">Cobro o anticipo</DialogTitle>
    <DialogDescription className="text-sm text-muted-foreground mt-2">Reciba un pago nuevo o aplique un recibo existente sin duplicar el ingreso.</DialogDescription>
    <ReceiptForm {...props} presentation="embedded" onSaved={onClose} onBusyChange={setBusy}/>
  </DialogContent></Dialog>;
}
