'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {useBusiness} from '@/hooks/use-business';
import {costCommand,loadCosts,loadPurchasePayments,payDirectPurchase,type WorkshopCost,type DirectPurchasePayment} from '@/lib/supabase/workshop';
import {loadEstimates,type QuoteVersion} from '@/lib/supabase/estimates';
import {folio} from '@/controladores/folios';
import {diaryHref} from '@/controladores/linked-money';
import {classificationChoice,classificationError,costDispositions,costFinancialAccess,reconcileCosts,supplierSummary} from '@/controladores/workshop-cost-workspace';
import {costEntryError,costEntryHints,costEntryLabels,costEntryQuestion,retryCostEntryPayment,runCostEntry,
  type CostEntryAnswer,type CostEntryCostInput,type CostEntryDeps,type CostEntryPaymentInput} from '@/controladores/workshop-cost-entry';
import {localToday} from '@/lib/supabase/billing';
import {ExpenseInbox} from './linked-expense';
import {CaseCostAllocations} from './case-cost-allocations';
import {orderHref,type CaseFile} from '@/lib/supabase/cases';
import styles from './workshop-costs.module.css';

type EntryMode=''|'linked';
export function WorkshopCosts({orderId,file,onChange,onReviewQuotes,actionVariant='default'}:{
  orderId:string;file?:CaseFile;onChange?:()=>Promise<void>;onReviewQuotes?:()=>void;
  actionVariant?:'default'|'outline';
}){
  const {data,toast,can,refresh,open,modal}=useBusiness();
  const financial=costFinancialAccess(file?.financialAccess,can('expenses.read'));const writable=can('expenses.write');
  const [costs,setCosts]=useState<WorkshopCost[]>([]);const [payments,setPayments]=useState<DirectPurchasePayment[]>([]);
  const [quotes,setQuotes]=useState<QuoteVersion[]>([]);const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [loadError,setLoadError]=useState('');
  const [notice,setNotice]=useState('');const [selected,setSelected]=useState('');const [entering,setEntering]=useState(false);
  const [mode,setMode]=useState<EntryMode>('');const [mobileDetail,setMobileDetail]=useState(false);
  const [answer,setAnswer]=useState<CostEntryAnswer|''>('');const [purchaseDate,setPurchaseDate]=useState(()=>localToday());
  const [pendingPayment,setPendingPayment]=useState<{costId:string;amount:number;pending:number;payment:CostEntryPaymentInput}>();
  const attempts=useRef(new Map<string,string>());const sending=useRef(false);const loadRevision=useRef(0);
  const access=useRef({financial,writable,orderId});access.current={financial,writable,orderId};
  const lastModal=useRef(modal.kind);const detailRef=useRef<HTMLHeadingElement>(null);
  const loadedScope=useRef(orderId);
  const afterDelivery=data.orders.find(order=>order.id===orderId)?.status==='Entregado';
  const internal=data.orders.find(order=>order.id===orderId)?.internalJob;
  const rows=financial?reconcileCosts(costs,file?.costs,orderId):[];
  const active=rows.find(cost=>cost.id===selected)??rows[0];

  async function reload(){
    if(!access.current.financial)return [];
    const revision=++loadRevision.current;const scope=orderId;setLoadError('');
    try{
      const [nextCosts,nextPayments,nextQuotes]=await Promise.all([
        loadCosts(scope),loadPurchasePayments(scope),writable?loadEstimates().then(result=>
          result.quotes.filter(quote=>quote.order_id===scope&&quote.status==='Aprobado')):Promise.resolve([])]);
      if(revision!==loadRevision.current||!access.current.financial||access.current.orderId!==scope)return [];
      setCosts(nextCosts);setPayments(nextPayments);setQuotes(nextQuotes);setLoading(false);
      return nextCosts;
    }catch(error){
      if(revision===loadRevision.current&&access.current.financial&&access.current.orderId===scope){
        setLoadError((error as Error).message);setLoading(false);
      }
      throw error;
    }
  }
  useEffect(()=>{
    if(!financial){loadRevision.current++;setCosts([]);setPayments([]);setQuotes([]);setError('');setNotice('');setLoading(true);return;}
    if(loadedScope.current!==orderId){setLoading(true);loadedScope.current=orderId;}
    const returning=lastModal.current==='gasto'&&modal.kind!=='gasto';lastModal.current=modal.kind;
    void (async()=>{
      if(returning)await onChange?.();
      const next=await reload();
      if(returning&&access.current.financial){
        setNotice('Consulta actualizada. Seleccione el costo vinculado para desglosarlo; si el gasto quedó por asociar, use Vincular gasto existente.');
        setEntering(false);
        const fresh=next.filter(cost=>!(file?.costs??[]).some(previous=>previous.id===cost.id));
        if(fresh.length===1){setSelected(fresh[0].id);setMobileDetail(true);}
      }
    })().catch(()=>{});
    return()=>{loadRevision.current++;};
  },[orderId,financial,writable,modal.kind,data.movements.length]);

  async function changed(){await onChange?.();await reload();}
  function mayWrite(){return access.current.financial&&access.current.writable&&access.current.orderId===orderId;}
  function retryKey(body:string){
    // A failed payment keeps its key even if another cost action is reviewed
    // before retrying. Only a confirmed response retires this proposal.
    if(!attempts.current.has(body))attempts.current.set(body,crypto.randomUUID());
    return attempts.current.get(body)!;
  }
  async function submit(command:'classify',payload:Record<string,unknown>):Promise<boolean>{
    if(sending.current||!mayWrite())return false;
    sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command,payload});const key=retryKey(body);
    let saved:WorkshopCost;
    try{saved=await costCommand(command,payload,key,afterDelivery);}
    catch(error){if(mayWrite())setError((error as Error).message);sending.current=false;setBusy(false);return false;}
    attempts.current.delete(body);
    if(!mayWrite()){sending.current=false;setBusy(false);return true;}
    setCosts(previous=>reconcileCosts(previous,[saved],orderId));setSelected(saved.id);setMobileDetail(true);
    setNotice('Relación con el presupuesto guardada. No cambia el precio del cliente.');
    await changed().catch(()=>{if(mayWrite())setError('La relación ya se guardó. No vuelva a registrarla; actualice la consulta para ver el resultado.');});
    sending.current=false;setBusy(false);
    return true;
  }
  // Canonical commands behind the unified entry. The controller owns the order
  // of the commands; this component only provides the existing implementations.
  const entryDeps:CostEntryDeps={
    keyFor:body=>retryKey(body),
    purchase:async(payload,key)=>{
      const saved=await costCommand('purchase',payload,key,afterDelivery);
      if(mayWrite()){setCosts(previous=>reconcileCosts(previous,[saved],orderId));setSelected(saved.id);setMobileDetail(true);}
      return {id:saved.id,amount:Number(saved.amount)};
    },
    pay:async(costId,payload,key)=>{
      const saved=await payDirectPurchase(costId,payload,key);
      if(mayWrite())setPayments(previous=>[...previous.filter(payment=>payment.id!==saved.id),saved]);
    },
    linkedExpense:orderId=>{open('gasto',orderId);},
  };
  async function runEntry(answer:CostEntryAnswer,cost:CostEntryCostInput,payment?:CostEntryPaymentInput){
    if(sending.current||!mayWrite())return;
    sending.current=true;setBusy(true);setError('');
    try{
      const outcome=await runCostEntry(answer,cost,payment,entryDeps);
      if(!mayWrite())return;
      if(outcome.state==='failed'){setError(outcome.error);return;}
      if(outcome.state==='linked-expense')return;
      if(outcome.state==='payment-pending'){
        // The cost is saved and the payment failed: keep the cost, show the
        // exact pending amount and allow retrying only the payment.
        setError(outcome.error);
        setPendingPayment({costId:outcome.costId,amount:outcome.amount,pending:outcome.pending,payment:payment!});
        await changed().catch(()=>{});
        return;
      }
      setPendingPayment(undefined);setAnswer('');setEntering(false);
      setNotice(outcome.notice==='credit'
        ?`Costo guardado (${money(outcome.amount/100)}). El pago al proveedor queda pendiente: ${money(outcome.pending/100)}. Regístrelo con "Registrar pago al proveedor" en el detalle del costo.`
        :`Costo y primer pago al proveedor guardados. Queda pendiente con el proveedor: ${money(outcome.pending/100)}.`);
      await changed().catch(()=>{if(mayWrite())setError('El costo ya se guardó. No vuelva a registrarlo; actualice la consulta para ver el resultado.');});
    }finally{sending.current=false;setBusy(false);}
  }
  async function retryPayment(){
    if(!pendingPayment||sending.current||!mayWrite())return;
    sending.current=true;setBusy(true);setError('');
    try{
      const outcome=await retryCostEntryPayment({costId:pendingPayment.costId,amount:pendingPayment.amount},pendingPayment.payment,entryDeps);
      if(!mayWrite())return;
      if(outcome.state==='payment-pending'){setError(outcome.error);return;}
      if(outcome.state!=='saved')return;
      setPendingPayment(undefined);setAnswer('');setEntering(false);
      setNotice(`Pago al proveedor confirmado. Queda pendiente con el proveedor: ${money(outcome.pending/100)}.`);
      await changed().catch(()=>{if(mayWrite())setError('Pago confirmado. Actualice la consulta antes de registrar otro pago.');});
    }finally{sending.current=false;setBusy(false);}
  }
  async function pay(costId:string,payload:Record<string,unknown>,form:HTMLFormElement){
    if(sending.current||!mayWrite())return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command:'pay',costId,payload});const key=retryKey(body);
    try{
      const saved=await payDirectPurchase(costId,payload,key);attempts.current.delete(body);
      if(!mayWrite())return;
      setPayments(previous=>[...previous.filter(payment=>payment.id!==saved.id),saved]);
      form.reset();setNotice('Pago al proveedor confirmado. El costo adquirido y el precio del cliente no cambian.');
      await changed().catch(()=>{if(mayWrite())setError('Pago confirmado. Actualice la consulta antes de registrar otro pago.');});
      await refresh().catch(()=>toast('Pago confirmado. Actualice el diario para ver el movimiento.'));
    }catch(error){if(mayWrite())setError((error as Error).message);}
    finally{sending.current=false;setBusy(false);}
  }
  function selectCost(id:string){setSelected(id);setMobileDetail(true);requestAnimationFrame(()=>detailRef.current?.focus());}
  if(!financial)return <p className="inline-note">Información financiera restringida.</p>;
  const currentQuotes=quotes.filter(quote=>quote.order_id===orderId&&quote.status==='Aprobado');
  return <section className={styles.workspace} aria-label={`Costos de ${orderId}`}>
    <header className={styles.heading}><div><h3>Costos registrados</h3>
      <p>Un costo, su desglose y sus pagos. Ninguna de estas acciones cambia el precio del cliente.</p></div>
      <Button variant={actionVariant} disabled={!writable||busy} aria-expanded={entering} onClick={()=>{setEntering(!entering);setMode('');setAnswer('');setPendingPayment(undefined);}}>Registrar costo</Button></header>
    {!internal&&<Link className="text-link" href={orderHref(orderId)+'&seccion='+encodeURIComponent('Presupuestos')} onClick={onReviewQuotes}>Revisar presupuesto →</Link>}
    {afterDelivery&&<p className="inline-note">Orden entregada: solo gerencia puede registrar ajustes con motivo. El acta original no cambia.</p>}
    {entering&&writable&&<section className={styles.entry} aria-label="Registrar costo">
      <h4>{costEntryQuestion}</h4>
      <div className={styles.choices} role="group" aria-label={costEntryQuestion}>
        {(['full','part','none'] as CostEntryAnswer[]).map(option=><Button key={option} type="button"
          variant={answer===option?undefined:'outline'} aria-pressed={answer===option}
          onClick={()=>{setAnswer(option);setMode('');setPendingPayment(undefined);setError('');}}>{costEntryLabels[option]}</Button>)}
      </div>
      {answer&&<p className="field-hint">{costEntryHints[answer]}</p>}
      {answer==='full'&&<div className={styles.fullEntry}>
        <p className="inline-note">Se abrirá el registro de gasto, donde se indica el importe, el medio de pago y la cuenta. Quedará una sola salida de dinero y el costo ligado a este trabajo.</p>
        <Button type="button" onClick={()=>{open('gasto',orderId);}}>Registrar el gasto pagado</Button></div>}
      {answer&&answer!=='full'&&!pendingPayment&&<form className="operation-form" onSubmit={event=>{
        event.preventDefault();const f=new FormData(event.currentTarget);
        const text=(name:string)=>String(f.get(name)??'').trim();
        const cost:CostEntryCostInput={orderId,description:text('description'),quantity:text('quantity'),
          unitCost:text('unitCost'),supplier:text('supplier'),sourceReference:text('sourceReference'),date:text('date'),
          ...(afterDelivery?{reason:text('reason')}:{})};
        const payment:CostEntryPaymentInput|undefined=answer==='part'?{amount:text('amount'),date:text('paymentDate'),
          method:text('method'),account:text('account')}:undefined;
        const problem=costEntryError(answer,cost,payment);
        if(problem){setError(problem);return;}
        void runEntry(answer,cost,payment);
      }}><fieldset disabled={busy} className={styles.fields}>
        <label className="form-field"><span>Repuesto o servicio adquirido</span><input name="description" required maxLength={2000}/></label>
        <div className="form-grid"><label className="form-field"><span>Cantidad adquirida</span><input name="quantity" required type="number" min="0.0001" step="0.0001" defaultValue="1"/></label>
          <label className="form-field"><span>Costo unitario real (USD)</span><input name="unitCost" required type="number" min="0.0001" step="0.0001"/></label></div>
        <label className="form-field"><span>Proveedor de compra</span><input name="supplier" required/></label>
        <label className="form-field"><span>Referencia de factura y línea</span><input name="sourceReference" required/></label>
        <label className="form-field"><span>Fecha de compra</span><input name="date" type="date" required value={purchaseDate} onChange={event=>setPurchaseDate(event.target.value)}/></label>
        {afterDelivery&&<label className="form-field"><span>Motivo del ajuste posterior</span><textarea name="reason" required/></label>}
        {answer==='part'&&<>
          <p className="inline-note">Este pago al proveedor es una salida de dinero. Lo que no se pague ahora queda pendiente con el proveedor.</p>
          <label className="form-field"><span>Importe pagado ahora (USD)</span><input name="amount" type="number" min="0.01" step="0.01" required/></label>
          <label className="form-field"><span>Fecha del pago</span><input name="paymentDate" type="date" min={purchaseDate} required defaultValue={purchaseDate}/></label>
          <label className="form-field"><span>Medio del pago</span><select name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
          <label className="form-field"><span>Cuenta o caja del pago</span><input name="account" required/></label></>}
        <Button type="submit">{busy?'Guardando…':answer==='part'?'Guardar costo y primer pago':'Guardar costo de compra'}</Button>
      </fieldset></form>}
      {pendingPayment&&<div className={styles.pendingPayment}>
        <p role="status">El costo quedó registrado y el pago al proveedor no se confirmó. No vuelva a registrar el costo.</p>
        <dl className={styles.paymentTotals}><div><dt>Costo adquirido</dt><dd>{money(pendingPayment.amount/100)}</dd></div>
          <div><dt>Pendiente con el proveedor</dt><dd>{money(pendingPayment.pending/100)}</dd></div></dl>
        <p className="field-hint">Solo falta el pago. Al reintentarlo se usa la misma operación: no se registra otro costo ni otra salida de dinero.</p>
        <Button type="button" onClick={()=>{void retryPayment();}} disabled={busy}>{busy?'Pagando…':'Reintentar solo el pago al proveedor'}</Button>
      </div>}
      <div className={styles.secondary}>
        <Button type="button" variant="outline" aria-pressed={mode==='linked'} onClick={()=>{setMode(mode==='linked'?'':'linked');}}>Vincular gasto existente</Button>
        <p className="field-hint">Para un gasto ya registrado en el diario, cuyo dinero ya salió de la cuenta. No registra otra salida de dinero.</p>
      </div>
      {mode==='linked'&&<><p className="inline-note">Repartir un gasto entre trabajos es distinto de desglosar el costo de este trabajo.</p>
        <ExpenseInbox orderId={orderId} onChange={async()=>{
          const before=new Set(rows.map(cost=>cost.id));await onChange?.();const next=await reload();
          if(!mayWrite())return;
          const fresh=next.filter(cost=>!before.has(cost.id));
          if(fresh.length===1){setSelected(fresh[0].id);setMobileDetail(true);}
          setEntering(false);setMode('');setNotice('Vínculo guardado. Seleccione el costo para desglosar solo el importe de este trabajo.');
        }}/></>}
    </section>}
    {notice&&<p role="status" className={styles.notice}>{notice}</p>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    {loadError&&<div role="alert" className="form-error">No se pudo actualizar la información financiera: {loadError}
      <Button variant="outline" disabled={loading} onClick={()=>{void reload().catch(()=>{});}}>Reintentar consulta</Button></div>}
    {loading?<p role="status">Consultando costos y pagos…</p>:<>
      {!loadError&&<p className={styles.total}>Costo registrado de este trabajo <strong>{money(rows.reduce((sum,cost)=>sum+Math.round(Number(cost.amount)*100),0)/100)}</strong></p>}
      {!rows.length?<p className={styles.empty}>{loadError?'La consulta no está disponible. No se puede confirmar el total.':'Aún no hay costos registrados. Use Registrar costo para comenzar.'}</p>:
        <div className={`${styles.layout} ${mobileDetail?styles.detailOpen:''}`}>
          <div className={styles.list} aria-label="Lista de costos">{rows.map(cost=><button key={cost.id} type="button"
            aria-pressed={active?.id===cost.id} onClick={()=>selectCost(cost.id)}>
            <span><strong>{cost.description}</strong><small>{cost.kind}</small>
              <small>{cost.disposition==='Pendiente'?'Por revisar presupuesto':cost.disposition==='Interno'?'A cargo del negocio':cost.disposition}</small></span>
            <b>{money(cost.amount)}</b></button>)}</div>
          <div className={styles.details}>
            <Button className={styles.back} variant="outline" onClick={()=>{setMobileDetail(false);requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>(`[aria-label="Lista de costos"] button[aria-pressed="true"]`)?.focus());}}>Volver a costos</Button>
            {rows.map(cost=>{
              const summary=supplierSummary(cost,payments);const direct=cost.kind==='Compra directa';
              const expenseId=cost.expense_id??cost.linked_expense_id;
              return <article key={cost.id} hidden={active?.id!==cost.id} aria-label={`Detalle de ${cost.description}`} className={styles.record}>
                <header className={styles.identity}><div><small>{cost.kind} · {cost.occurred_at}</small>
                  <h4 ref={active?.id===cost.id?detailRef:undefined} tabIndex={-1}>{cost.description}</h4>
                  <p>{cost.supplier}{cost.source_reference?` · ${cost.source_reference}`:''}</p><small>Identificador: {cost.id}</small>
                </div><strong>{money(cost.amount)}</strong></header>
                <section className={styles.section}><h5>Resumen</h5>
                  <p>{cost.linked_expense_id?'Importe asignado a este trabajo; no es el total del gasto compartido.':'Costo adquirido de este trabajo, independiente del precio al cliente.'}</p>
                  {expenseId&&<Link className="text-link" href={diaryHref(orderId,'expense:'+expenseId,cost.occurred_at)}>Abrir gasto original en Libro diario →</Link>}
                </section>
                <section className={styles.section}><h5>Desglose <span>Opcional</span></h5>
                  {file&&!afterDelivery?<CaseCostAllocations file={file} cost={cost} onChange={changed}/>:
                    <><p className="field-hint">{afterDelivery?'El desglose se conserva como parte del trabajo entregado.':'Actualice el expediente para consultar y editar el desglose.'}</p>
                      {file?.allocations?.filter(line=>line.cost_id===cost.id).map(line=><p key={line.id}>{line.description} · {money(line.amount)}</p>)}</>}
                </section>
                <section className={styles.section}><h5>¿Este costo está incluido en el presupuesto?</h5>
                  <p className={styles.status}>{cost.disposition==='Pendiente'?'Por revisar':cost.disposition==='Interno'?'A cargo del negocio (Interno)':cost.disposition}</p>
                  {cost.reason&&<p>{cost.reason}</p>}<p className="field-hint">No cambia el precio del cliente. Incluido y adicional requieren un presupuesto aprobado.</p>
                  {writable&&<ClassificationForm cost={cost} quotes={currentQuotes} busy={busy||!!loadError} internal={!!internal} onSubmit={submit}/>}
                </section>
                <section className={styles.section}><h5>Pago al proveedor</h5>
                  {direct?<><dl className={styles.paymentTotals}><div><dt>Costo adquirido</dt><dd>{money(cost.amount)}</dd></div>
                    <div><dt>Pagado</dt><dd>{loadError?'Consulta pendiente':money(summary.paid/100)}</dd></div>
                    <div><dt>Pendiente de pago</dt><dd>{loadError||summary.pending===null?'Consulta pendiente':money(summary.pending/100)}</dd></div></dl>
                    <p className="field-hint">Registrar un pago no aumenta el costo ni modifica el desglose o el precio del cliente.</p>
                    {payments.filter(payment=>payment.direct_purchase_cost_id===cost.id).map(payment=><p key={payment.id}>
                      {payment.date} · {money(payment.amount)} <Link className="text-link" href={diaryHref(orderId,'expense:'+payment.id,payment.date)}>Ver pago en Libro diario →</Link></p>)}
                    {writable&&summary.pending!==null&&summary.pending>0&&<details><summary>Registrar pago al proveedor</summary>
                      <form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
                        void pay(cost.id,Object.fromEntries(['amount','date','method','account'].map(key=>[key,String(f.get(key)??'')])),form);
                      }}><fieldset disabled={busy||!!loadError} className={styles.fields}>
                        <label className="form-field"><span>Importe del pago (USD)</span><input name="amount" type="number" min="0.01" max={summary.pending/100} step="0.01" required/></label>
                        <label className="form-field"><span>Fecha del pago</span><input name="date" type="date" min={cost.occurred_at} required defaultValue={new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date())}/></label>
                        <label className="form-field"><span>Medio del pago</span><select name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
                        <label className="form-field"><span>Cuenta del pago</span><input name="account" required/></label>
                        <Button variant="outline" type="submit">Guardar pago sin duplicar costo</Button>
                      </fieldset></form></details>}
                  </>:<p>El pago corresponde al gasto original del diario. No registre otro pago desde este costo.</p>}
                </section>
              </article>;
            })}
          </div>
        </div>}
    </>}
  </section>;
}

function ClassificationForm({cost,quotes,busy,internal,onSubmit}:{cost:WorkshopCost;quotes:QuoteVersion[];busy:boolean;internal:boolean;
  onSubmit:(command:'classify',payload:Record<string,unknown>)=>Promise<boolean>}){
  const [disposition,setDisposition]=useState(()=>classificationChoice(cost.disposition));
  const [estimateId,setEstimateId]=useState(cost.estimate_id??'');const [reason,setReason]=useState('');
  const [expectedVersion,setExpectedVersion]=useState(cost.version);const [dirty,setDirty]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{if(!dirty){setDisposition(classificationChoice(cost.disposition));setEstimateId(cost.estimate_id??'');setExpectedVersion(cost.version);}},[cost.version,dirty]);
  const needsScope=['Incluido','Adicional autorizado'].includes(disposition);const stale=expectedVersion!==cost.version;
  return <details><summary>Revisar relación con el presupuesto</summary><form className="operation-form" onSubmit={event=>{
    event.preventDefault();const message=classificationError(disposition,estimateId,quotes.map(quote=>quote.id),reason,internal);
    setError(message);if(message||stale)return;
    void onSubmit('classify',{costId:cost.id,expectedVersion,disposition,estimateId:needsScope?estimateId:null,reason:reason.trim()})
      .then(saved=>{if(saved){setDirty(false);setReason('');}});
  }}><fieldset disabled={busy} className={styles.fields}>
    <label className="form-field"><span>Relación con el presupuesto</span><select aria-label="Relación con el presupuesto" required name="disposition" value={disposition} onChange={event=>{setDirty(true);setDisposition(event.target.value);}}>
      <option value="">Seleccione una opción</option>{costDispositions.map(value=><option key={value} value={value}
        disabled={internal&&['Incluido','Adicional autorizado'].includes(value)}>{value==='Interno'?'A cargo del negocio (Interno)':value}</option>)}</select></label>
    {needsScope&&<label className="form-field"><span>Presupuesto aprobado de este trabajo</span><select aria-label="Presupuesto aprobado de este trabajo" required name="estimateId" value={estimateId} onChange={event=>{setDirty(true);setEstimateId(event.target.value);}}>
      <option value="">Seleccione un presupuesto aprobado</option>{quotes.map(quote=><option key={quote.id} value={quote.id}>{folio('PRE',quote.folio_number)} · Versión {quote.revision}</option>)}</select></label>}
    {needsScope&&!quotes.length&&<p className="inline-note">No hay un presupuesto aprobado disponible. Revise el presupuesto antes de guardar esta opción.</p>}
    <label className="form-field"><span>Motivo de la decisión</span><input required name="reason" value={reason} onChange={event=>{setDirty(true);setReason(event.target.value);}}/></label>
    {stale&&<div role="alert" className="inline-note">El costo cambió. Revise la información actual antes de guardar su decisión.
      <Button type="button" variant="outline" onClick={()=>setExpectedVersion(cost.version)}>Revisé el costo actualizado; conservar mi decisión</Button></div>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    <Button variant="outline" type="submit" disabled={stale||!disposition||(needsScope&&!quotes.some(quote=>quote.id===estimateId))}>Guardar relación con el presupuesto</Button>
  </fieldset></form></details>;
}
