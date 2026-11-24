'use client';
import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,RefreshCw,Search,Wallet,FileText,Receipt,Plus} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {Badge,statusTone} from '@/components/atoms/badge';
import {VehicleImage} from '@/components/organisms/vehicle-image';
import {AdvancedBilling} from '@/components/organisms/billing-advanced';
import {WorkbookWorkspace} from '@/components/organisms/workbook-preview';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {operationMoney} from '@/controladores/operation-money';
import {approvedScopeTotal} from '@/controladores/workshop-money-language';
import {rentalAccounts,rentalMoneyEvidence,rentalReconciliationAlarm,reconciliationAlarm} from '@/controladores/rental-lifecycle';
import {rentalWorkflow} from '@/controladores/rental-workflow';
import {loadBilling,localToday,type Receivable} from '@/lib/supabase/billing';
import {loadCalendar} from '@/lib/supabase/reservations';
import {loadCase,loadRentalCase,orderHref,rentalHref,caseCommand,type CaseFile} from '@/lib/supabase/cases';
import {CobrosScreen} from './cobros-screen';
import {ReceiptDialog} from '@/components/organisms/linked-receipt';
import {diaryHref} from '@/controladores/linked-money';

interface Operation {id:string;kind:'Taller'|'Alquiler';vehicleId:string;customer:string;customerId?:string;title:string;internal?:boolean;active:boolean;}
export function BillingScreen(){const {source}=useBusiness();return source==='supabase'?<BillingWorkspace/>:<CobrosScreen/>;}
function BillingWorkspace(){
  const {data,modal,toast}=useBusiness();const [rentals,setRentals]=useState<Operation[]>([]);
  const [documents,setDocuments]=useState<Receivable[]>([]);const [files,setFiles]=useState<Record<string,CaseFile>>({});
  const [query,setQuery]=useState('');const [area,setArea]=useState('Todas');const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');const [revision,setRevision]=useState(0);const [advanced,setAdvanced]=useState(false);
  const [operationFilter,setOperationFilter]=useState('');
  const readRevision=useRef(0);
  useEffect(()=>{setOperationFilter(new URLSearchParams(window.location.search).get('operacion')??'');},[]);
  const reload=useCallback(async()=>{
    const request=++readRevision.current;setLoading(true);
    try{const [billing,calendar]=await Promise.all([loadBilling(localToday()),loadCalendar()]);
      if(request!==readRevision.current)return;
      setDocuments(billing.documents);setRentals(calendar.reservations.filter(r=>r.status!=='Cancelada'||billing.documents.some(d=>d.reservation_id===r.id))
        .map(r=>({id:r.id,kind:'Alquiler',vehicleId:r.vehicle_id,customer:r.customer_snapshot.name,customerId:r.customer_id,
          active:r.status!=='Cancelada'&&['Preparado','Entregado'].includes(r.rental_state),title:`Alquiler · ${folio('ALQ',r.folio_number)}`})));
      setRevision(value=>value+1);setError('');
    }catch(error){if(request===readRevision.current)throw error;}
    finally{if(request===readRevision.current)setLoading(false);}
  },[]);
  useEffect(()=>{let active=true;void reload().catch(error=>{if(active)setError(error.message);});
    return()=>{active=false;readRevision.current++;};},[reload,data,modal.kind]);
  const operations:Operation[]=[...data.orders.map(o=>({id:o.id,kind:'Taller' as const,vehicleId:o.vehicleId,internal:o.internalJob,
    active:o.status!=='Entregado',customer:o.internalJob?'AJ · Mantenimiento interno':data.customers.find(c=>c.id===o.customerId)?.name??'Cliente sin registrar',
    customerId:o.customerId??undefined,title:o.service})),...rentals].sort((a,b)=>Number(b.active)-Number(a.active));
  const filtered=operations.filter(o=>{const car=data.vehicles.find(v=>v.id===o.vehicleId);return(!operationFilter||o.id===operationFilter)&&(area==='Todas'||o.kind===area)&&
    `${o.title} ${o.customer} ${car?.plate} ${car?.brand} ${car?.model}`.toLowerCase().includes(query.toLowerCase());});
  const page=usePagination(filtered,query+area);const pageKey=page.items.map(o=>o.id).join('|');
  useEffect(()=>{let active=true;
    void Promise.all(page.items.map(async o=>[o.id,o.kind==='Taller'?await loadCase(o.vehicleId,o.id):await loadRentalCase(o.id)] as const))
      .then(entries=>{if(active)setFiles(current=>({...current,...Object.fromEntries(entries)}));})
      .catch(error=>{if(active)setError(error.message);});return()=>{active=false;};
  },[pageKey,revision]);
  const pending=documents.reduce((sum,d)=>sum+Number(d.balance),0);
  const overdue=documents.filter(d=>d.days_overdue>0).reduce((sum,d)=>sum+Number(d.balance),0);
  return <><PageHeading title="Cobros" description="Cada trabajo y alquiler: lo que se emitió, lo que se cobró y lo que falta por cobrar."/>
    <WorkbookWorkspace format="receivables"
    actions={<Button variant="outline" disabled={loading} onClick={()=>{void reload().then(()=>toast('Cobros actualizados.')).catch(error=>setError(error.message));}}>
      <RefreshCw size={15} className={loading?'animate-spin':''}/>Actualizar</Button>}>
      <div className="collection-metrics"><article><span><Wallet size={17}/>Pendiente de cobro</span><strong>{loading?'—':money(pending)}</strong><small>Documentos emitidos con saldo</small></article>
        <article><span><Receipt size={17}/>Saldo vencido</span><strong>{loading?'—':money(overdue)}</strong><small>Al {new Date(localToday()+'T12:00:00').toLocaleDateString('es-SV')}</small></article>
        <article><span><FileText size={17}/>Trabajos y alquileres</span><strong>{operations.length}</strong><small>Incluye presupuestos aún sin emitir</small></article></div>
      <div className="collection-toolbar"><div className="search-field"><Search size={16}/><input aria-label="Buscar operación de cobro" placeholder="Cliente, placa o trabajo" value={query} onChange={e=>setQuery(e.target.value)}/></div>
        <select aria-label="Tipo de operación" value={area} onChange={e=>setArea(e.target.value)}><option>Todas</option><option>Taller</option><option>Alquiler</option></select></div>
      {operationFilter&&<button className="text-link mb-4" onClick={()=>setOperationFilter('')}>← Mostrar todas las operaciones</button>}
      <div className="collection-list">{page.items.map(operation=><OperationCollection key={operation.id} operation={operation} file={files[operation.id]} onChange={reload}/>)}</div>
      {!filtered.length&&<section className="panel collection-empty"><Wallet size={30}/><h2>{loading?'Cargando operaciones…':'No hay operaciones en esta vista'}</h2><p>Los trabajos de taller aparecen aquí con su presupuesto. Un presupuesto por sí solo no es un cobro.</p></section>}
      <Pagination {...page}/>
      <details className="collection-advanced" onToggle={event=>setAdvanced(event.currentTarget.open)}><summary>Importaciones, documentos agrupados y otros ajustes</summary>
        {advanced&&<div className="mt-5"><AdvancedBilling onChange={reload}/></div>}</details>
    </WorkbookWorkspace>{error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </>;
}

// The card states two different facts: the state of the operation and the state of the money.
// A rental can be finished and still owe money, so one badge alone is never enough.
export function rentalOperationLabel(booking:{status:string;rental_state:string}|null|undefined,finalized:boolean):string{
  if(!booking)return 'Cargando…';
  if(booking.status==='Cancelada')return 'Reserva cancelada';
  if(booking.status==='Borrador')return 'Reserva sin confirmar';
  if(booking.rental_state==='Preparado')return 'Reservado';
  if(booking.rental_state==='Entregado')return 'Alquilado';
  if(booking.rental_state==='Devuelto')return 'Devuelto';
  return finalized?'Finalizado':'Devuelto';
}
// The workshop order status is the canonical state of the work itself.
export function workshopOperationLabel(status:string|null):string{return status??'Cargando…';}
// The money state keeps the badge tone semantics and says the same fact in plain words.
export function collectionMoneyState(state:string|null):string{
  if(!state)return 'Cargando…';
  if(state==='Pendiente'||state==='Por cobrar')return 'Pendiente por cobrar';
  if(state==='Pago parcial')return 'Cobro parcial, pendiente por cobrar';
  if(state==='Por emitir')return 'Pendiente de emitir el documento';
  if(state==='Sin saldo')return 'Cobrado';
  if(state==='Sin cargo')return 'Sin importes emitidos';
  if(state==='Por aprobar')return 'Presupuesto por aprobar';
  if(state==='Rechazado')return 'Presupuesto rechazado';
  return state;
}
// Both facts read together, so a finished rental that still owes money says so.
export function collectionStatusReading(operationLabel:string,moneyState:string):string{
  return `${operationLabel} · ${moneyState}`;
}

function OperationCollection({operation,file,onChange}:{operation:Operation;file?:CaseFile;onChange:()=>Promise<void>}){
  const {data,can,open}=useBusiness();const [form,setForm]=useState<'issue'|null>(null);const [receiptOpen,setReceiptOpen]=useState(false);
  const {busy,error,execute}=useCaseAction(onChange);const car=data.vehicles.find(v=>v.id===operation.vehicleId);
  const amount=file?operationMoney(file,operation.kind==='Taller'?operation.id:undefined):null;
  const isRental=operation.kind==='Alquiler';
  // A rental has no quote: its pending amount comes from the agreed amount and the applied money.
  const rental=isRental?(file?.reservations.find(row=>row.id===operation.id)??file?.reservations[0]):undefined;
  const accounts=rental&&file?rentalAccounts(rentalMoneyEvidence(file,rental,null)):null;
  // The badge states the same fact as the pending amount: what still has to be collected.
  const rentalState=accounts?(accounts.pending>0?(accounts.pendingToEmit>0?'Pendiente de emitir el documento':'Pendiente por cobrar'):
    accounts.charged>0?'Cobrado':'Sin importes emitidos'):null;
  // The canonical rental workflow knows whether the operation is closed; the money state is a fact of its own.
  const workflow=rental&&file?rentalWorkflow(rental,file.commitments??[]):null;
  const order=file?.orders.find(o=>o.id===operation.id)??file?.orders?.[0];
  const operationLabel=isRental?rentalOperationLabel(rental,workflow?.step===3):workshopOperationLabel(order?.status??null);
  const operationTone=isRental?(workflow?.tone??'gray'):statusTone(order?.status??'');
  const moneyState=isRental?(rentalState??'Cargando…'):collectionMoneyState(amount?.collectionState??null);
  const badgeTone=isRental?(rentalState&&rentalState!=='Cobrado'&&rentalState!=='Sin importes emitidos'?'amber':
    accounts?.charged?'green':'gray'):(amount?.balance?'amber':amount?.charged?'green':'gray');
  const href=operation.kind==='Taller'?orderHref(operation.id):rentalHref(operation.id);
  const payable=file?.documents?.filter(d=>d.scope_balance>0&&!d.grouped)??[];
  const inconsistentWorkshop=operation.kind==='Taller'&&!operation.internal&&car?.ownership==='Propio';
  const quoteHref=amount?.quote?`/presupuestos/?id=${encodeURIComponent(amount.quote.id)}`:operation.kind==='Taller'?`/presupuestos/?trabajo=${encodeURIComponent(operation.id)}`:href;
  const detailLabel=isRental?operation.title.replace(/^Alquiler · /,''):operation.title;
  const canIssue=can('expenses.write')&&operation.kind==='Taller'&&!operation.internal&&!inconsistentWorkshop&&!!amount?.unbilled;
  const agreedLabel=operation.internal&&!isRental?'Costo presupuestado':'Importe acordado';
  // The agreed amount of a workshop job is its approved scope, never a revision in draft.
  const agreedScope=isRental?null:approvedScopeTotal(file??{},operation.kind==='Taller'?operation.id:undefined);
  const agreedValue=isRental?(accounts?accounts.agreed==null?'Sin total acordado':money(accounts.agreed):'—'):
    !amount?'—':operation.internal?(amount.quote?.snapshot.costComplete===false?'Sin costo aún':money(amount.quote?.snapshot.cost??0)):
      agreedScope!==null?money(agreedScope):amount.quoted===null?'Sin presupuesto':money(amount.quoted);
  const agreedNote=operation.internal&&!isRental?'Mantenimiento interno, no es una venta':
    isRental?'Lo pactado con el cliente en este alquiler.':'Importe del presupuesto vigente con el cliente.';
  // The reconciliation alarm: what was agreed against what was already issued. It only informs
  // the operator: no button, no command and no permission changes because of it. Without the
  // financial access there is no money to compare and therefore no alarm.
  const alarm=!file?.financialAccess?null:isRental?rentalReconciliationAlarm(accounts):
    (operation.internal?null:reconciliationAlarm(agreedScope,amount?amount.charged:null));
  const collectedValue=isRental?(accounts?money(accounts.paid):'—'):amount?money(amount.paid):'—';
  const collectedNote=isRental?'Pagos reales vinculados.':'Cobros aplicados a este trabajo.';
  const pendingValue=isRental?(accounts?money(accounts.pending):'—'):
    !amount?'—':amount.charged?money(amount.balance):'Sin importes emitidos';
  const pendingNote=alarm
    ?(isRental?'Saldo emitido e importe acordado que falta emitir.':'Saldo de los importes emitidos al cliente.')
    :isRental?(accounts&&accounts.pendingToEmit>0?'Falta emitir el documento de cobro.':'Saldo pendiente.'):
      amount?.unbilled?'Hay presupuesto aprobado por emitir.':amount?.quote?.status==='Borrador'?'Presupuesto pendiente de aprobar.':'Saldo pendiente.';
  const overdue=!!file?.documents?.some(d=>d.scope_balance>0&&d.due_on<localToday());
  return <article className="collection-card" aria-label={`${operation.customer} · ${car?.plate||car?.model||operation.kind}`}>
    <header><VehicleImage vehicleId={operation.vehicleId} plate={car?.plate??''} fileId={car?.primaryPhotoId} size="thumbnail"/>
      <div className="collection-identity"><span className="collection-kind">{operation.kind}{operation.kind==='Taller'?` · ${folio('OT',operation.id)}`:''}</span>
        <h2>{operation.customer} · {car?.brand} {car?.model}{car?.plate?` · ${car.plate}`:''}</h2>
        <small>{detailLabel}</small></div>
      <div className="collection-statuses" role="group" aria-label={collectionStatusReading(operationLabel,moneyState)}
        title={isRental?workflow?.description:undefined}>
        <Badge tone={operationTone}>{operationLabel}</Badge>
        <span className="collection-status-dot" aria-hidden="true">·</span>
        <Badge tone={badgeTone}>{moneyState}</Badge></div>
    </header>
    <dl className="collection-money" aria-label="Resumen de cobros de la operación">
      <div><dt>{agreedLabel}</dt><dd>{agreedValue}</dd><small>{agreedNote}</small></div>
      <div><dt>Cobrado</dt><dd className="collection-money-paid">{collectedValue}</dd><small>{collectedNote}</small></div>
      <div className="collection-money-pending"><dt>Por cobrar</dt><dd>{pendingValue}</dd><small>{pendingNote}</small></div>
    </dl>
    {alarm&&<p className="collection-alarm" data-testid="reconciliation-alarm"
      style={{margin:0,padding:'8px 24px',borderInlineStart:'3px solid #c99a2e',background:'#fdf7e8',color:'#6f5518',fontSize:'11.5px',lineHeight:1.5}}>
      {alarm.text}</p>}
    <div className="collection-actions">
      {(!isRental||amount?.quote)&&<Button variant="outline" size="sm" asChild><Link href={quoteHref}>{amount?.quote?'Ver presupuesto':'Ver presupuesto del trabajo'}</Link></Button>}
      {can('expenses.write')&&operation.kind==='Taller'&&<Button variant="ghost" size="sm" onClick={()=>open('gasto',operation.id)}><Plus size={14}/>Registrar gasto</Button>}
      {canIssue&&<Button size="sm" onClick={()=>setForm(form==='issue'?null:'issue')}>Emitir importe a cobrar</Button>}
      {can('expenses.write')&&!operation.internal&&(!inconsistentWorkshop||payable.length>0)&&operation.customerId&&
        <Button variant="outline" size="sm" onClick={()=>setReceiptOpen(true)}><Wallet size={14}/>{payable.length?'Registrar cobro':'Registrar anticipo'}</Button>}
      <Link className="collection-case-link" href={href}>Ver expediente<ArrowUpRight size={14}/></Link>
    </div>
    {form&&<form className="collection-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);
      const payload={orderId:operation.id,date:String(f.get('date')),dueOn:String(f.get('dueOn'))};
      void execute('bill_scope',payload,key=>caseCommand('bill_scope',payload,key))
        .then(saved=>{if(saved)setForm(null);});
    }}><h3>Emitir el importe a cobrar pendiente del presupuesto</h3>
      <p>Importe pendiente de emitir: <strong>{money(amount?.unbilled??0)}</strong>. Esto registra una cuenta por cobrar, no una entrada de dinero.</p>
      <div className="form-grid"><label className="form-field"><span>Fecha de emisión</span><input name="date" type="date" defaultValue={localToday()} required/></label>
        <label className="form-field"><span>Fecha de vencimiento</span><input name="dueOn" type="date" defaultValue={localToday()} required/></label></div>
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}>{busy?'Guardando…':'Confirmar emisión'}</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>setForm(null)}>Cancelar</Button></div>
    </form>}
    <details className="collection-detail"><summary>Detalle</summary>
      <dl className="operation-amounts">{isRental?<>
        <div><dt>Importe acordado</dt><dd>{!accounts?'—':accounts.agreed==null?'Sin total acordado':money(accounts.agreed)}</dd>
          <small>Lo pactado con el cliente en este alquiler.</small></div>
        <div><dt>Importes emitidos al cliente</dt><dd>{accounts?money(accounts.charged):'—'}</dd><small>{file?.documents?.length??0} documentos</small></div>
        <div><dt>Cobros aplicados</dt><dd className="amount-paid">{accounts?money(accounts.paid):'—'}</dd><small>Pagos reales vinculados</small></div>
        <div className="amount-outstanding"><dt>Por cobrar</dt><dd>{accounts?money(accounts.pending):'—'}</dd>
          <small>{accounts&&accounts.pendingToEmit>0?'Falta emitir el documento de cobro de este importe':'Saldo pendiente'}</small></div>
      </>:<>
        <div><dt>{operation.internal?'Costo presupuestado':'Presupuesto'}</dt><dd>{!amount?'—':amount.quoted===null?'Sin presupuesto':
          operation.internal?(amount.quote?.snapshot.costComplete===false?'Sin costo aún':money(amount.quote?.snapshot.cost??0)):money(amount.quoted)}</dd>
          <small>{operation.internal?'Mantenimiento interno, no es una venta':amount?.quote?`${folio('PRE',amount.quote.folio_number)} · ${amount.quote.status}`:'Por preparar'}</small></div>
        <div><dt>Importes emitidos al cliente</dt><dd>{amount?money(amount.charged):'—'}</dd><small>{file?.documents?.length??0} documentos</small></div>
        <div><dt>Cobros aplicados</dt><dd className="amount-paid">{amount?money(amount.paid):'—'}</dd><small>Pagos reales vinculados</small></div>
        <div className="amount-outstanding"><dt>Por cobrar</dt><dd>{!amount?'—':amount.charged?money(amount.balance):'Sin importes emitidos'}</dd><small>{amount?.unbilled?'Hay presupuesto aprobado por emitir':amount?.quote?.status==='Borrador'?'Presupuesto pendiente de aprobar':'Saldo pendiente'}</small></div>
      </>}</dl>
      {!!amount?.pendingCosts&&<p className="inline-note">{amount.pendingCosts} costos por revisar: confirme si ya están incluidos, son adicionales o los asume el negocio.
        <Link className="text-link ml-2" href={href+'&seccion=Costos'}>Revisar en el folio →</Link></p>}
      {!!amount?.advances&&<p className="inline-note">Anticipos vinculados sin aplicar: <strong>{money(amount.advances)}</strong>. Ya están recibidos; no los registre otra vez.</p>}
      {overdue&&<p className="inline-note">Este trabajo tiene saldo vencido. La entrega no cierra su cuenta por cobrar.</p>}
      {inconsistentWorkshop&&<p className="inline-note">Este expediente tiene cliente, pero el vehículo está registrado como propio de AJ. Revise el tipo de ingreso antes de cobrar; no se cambió su historial.</p>}
      {file&&<div className="collection-breakdown"><h3>Importes emitidos, pagos y gastos</h3>
        {!!file.documents?.length&&<AdaptiveTable><thead><tr><th>Importe emitido</th><th>Importe</th><th>Saldo</th></tr></thead><tbody>{file.documents.map(d=><tr key={d.id}><td>{d.description}<small>{folio('CAR',d.folio_number)}</small></td><td>{money(d.scope_amount)}</td><td>{money(d.scope_balance)}</td></tr>)}</tbody></AdaptiveTable>}
        {!file.documents?.length&&<p>Todavía no hay importes emitidos para esta operación.</p>}
        <h3 className="font-semibold mt-4">Pagos aplicados</h3>
        {(file.applications??[]).map(a=><p key={a.id}>{a.effective_on} · {a.kind==='Aplicacion'?'Pago aplicado':'Reversión de pago'} · <strong>{money(a.scope_amount)}</strong>
          <br/><Link className="text-link" href={diaryHref(operation.id,'receipt:'+a.payment_id,file.payments?.find(p=>p.id===a.payment_id)?.paid_on)}>Ver recibo original →</Link></p>)}
        {!file.applications?.length&&<p>No hay pagos aplicados a esta operación.</p>}
        {operation.kind==='Taller'&&<p className="mt-4">Los costos del trabajo y los gastos de caja se administran en el folio, no en esta tarjeta.
          <Link className="text-link" href={href+'&seccion='+encodeURIComponent('Trabajo y costos reales')}>Ver costos en el folio →</Link></p>}
        <Link className="text-link" href={`/libro-diario/?operacion=${encodeURIComponent(operation.id)}`}>Ver movimientos en Libro diario →</Link></div>}
    </details>{receiptOpen&&<ReceiptDialog customerId={operation.customerId} orderId={operation.kind==='Taller'?operation.id:undefined}
      reservationId={operation.kind==='Alquiler'?operation.id:undefined} onChange={onChange} onClose={()=>setReceiptOpen(false)}/>}{error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </article>;
}
