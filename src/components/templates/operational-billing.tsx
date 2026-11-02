'use client';
import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,RefreshCw,Search,Wallet,FileText,Receipt,Plus} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {VehicleImage} from '@/components/organisms/vehicle-image';
import {AdvancedBilling} from '@/components/organisms/billing-advanced';
import {WorkbookWorkspace} from '@/components/organisms/workbook-preview';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {operationMoney} from '@/controladores/operation-money';
import {loadBilling,localToday,type Receivable} from '@/lib/supabase/billing';
import {loadCalendar} from '@/lib/supabase/reservations';
import {loadCase,loadRentalCase,orderHref,rentalHref,caseCommand,type CaseFile} from '@/lib/supabase/cases';
import {CobrosScreen} from './cobros-screen';
import {ReceiptDialog} from '@/components/organisms/linked-receipt';
import {diaryHref} from '@/controladores/linked-money';

interface Operation {id:string;kind:'Taller'|'Alquiler';vehicleId:string;customer:string;customerId?:string;title:string;internal?:boolean;}
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
        .map(r=>({id:r.id,kind:'Alquiler',vehicleId:r.vehicle_id,customer:r.customer_snapshot.name,customerId:r.customer_id,title:`Alquiler · ${folio('ALQ',r.folio_number)}`})));
      setRevision(value=>value+1);setError('');
    }catch(error){if(request===readRevision.current)throw error;}
    finally{if(request===readRevision.current)setLoading(false);}
  },[]);
  useEffect(()=>{let active=true;void reload().catch(error=>{if(active)setError(error.message);});
    return()=>{active=false;readRevision.current++;};},[reload,data,modal.kind]);
  const operations:Operation[]=[...data.orders.map(o=>({id:o.id,kind:'Taller' as const,vehicleId:o.vehicleId,internal:o.internalJob,
    customer:o.internalJob?'AJ · Mantenimiento interno':data.customers.find(c=>c.id===o.customerId)?.name??'Cliente sin registrar',customerId:o.customerId??undefined,title:o.service})),...rentals];
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
  return <><PageHeading title="Cargos y cobros" description="Cada trabajo y alquiler, con su presupuesto, gastos, abonos y saldo."
    actions={<Button variant="outline" disabled={loading} onClick={()=>{void reload().then(()=>toast('Cargos y cobros actualizados.')).catch(error=>setError(error.message));}}>
      <RefreshCw size={15} className={loading?'animate-spin':''}/>Actualizar</Button>}/>
    <WorkbookWorkspace format="receivables">
      <div className="collection-metrics"><article><span><Wallet size={17}/>Pendiente de cobro</span><strong>{loading?'—':money(pending)}</strong><small>Cargos emitidos con saldo</small></article>
        <article><span><Receipt size={17}/>Saldo vencido</span><strong>{loading?'—':money(overdue)}</strong><small>Al {new Date(localToday()+'T12:00:00').toLocaleDateString('es-SV')}</small></article>
        <article><span><FileText size={17}/>Trabajos y alquileres</span><strong>{operations.length}</strong><small>Incluye presupuestos aún sin cargo</small></article></div>
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

function OperationCollection({operation,file,onChange}:{operation:Operation;file?:CaseFile;onChange:()=>Promise<void>}){
  const {data,can,open}=useBusiness();const [form,setForm]=useState<'issue'|null>(null);const [receiptOpen,setReceiptOpen]=useState(false);
  const {busy,error,execute}=useCaseAction(onChange);const car=data.vehicles.find(v=>v.id===operation.vehicleId);
  const amount=file?operationMoney(file,operation.kind==='Taller'?operation.id:undefined):null;
  const href=operation.kind==='Taller'?orderHref(operation.id):rentalHref(operation.id);
  const payable=file?.documents?.filter(d=>d.scope_balance>0&&!d.grouped)??[];
  const quoteHref=amount?.quote?`/presupuestos/?id=${encodeURIComponent(amount.quote.id)}`:operation.kind==='Taller'?`/presupuestos/?trabajo=${encodeURIComponent(operation.id)}`:href;
  return <article className="collection-card" aria-label={`${operation.customer} · ${car?.plate||car?.model||operation.kind}`}>
    <header><VehicleImage vehicleId={operation.vehicleId} plate={car?.plate??''} fileId={car?.primaryPhotoId} size="thumbnail"/>
      <div className="collection-identity"><span className="collection-kind">{operation.kind}{operation.kind==='Taller'?` · ${folio('OT',operation.id)}`:''}</span>
        <h2>{operation.customer}</h2><p>{car?.brand} {car?.model}{car?.plate?` · ${car.plate}`:''}</p><small>{operation.title}</small></div>
      <Badge tone={amount?.balance?'amber':amount?.charged?'green':'gray'}>{amount?.deliveredWithBalance?'Entregado con saldo':amount?.collectionState??'Cargando…'}</Badge>
    </header>
    <dl className="operation-amounts"><div><dt>{operation.internal?'Costo presupuestado':'Presupuesto'}</dt><dd>{!amount?'—':amount.quoted===null?'Sin presupuesto':
      operation.internal?(amount.quote?.snapshot.costComplete===false?'Por completar':money(amount.quote?.snapshot.cost??0)):money(amount.quoted)}</dd>
      <small>{operation.internal?'Mantenimiento interno, no es una venta':amount?.quote?`${folio('PRE',amount.quote.folio_number)} · ${amount.quote.status}`:operation.kind==='Alquiler'?'Según cargo del alquiler':'Por preparar'}</small></div>
      <div><dt>{operation.kind==='Taller'?'Costos del trabajo':'Gastos pagados'}</dt><dd>{amount?money(operation.kind==='Taller'?amount.costs:amount.cashOut):'—'}</dd>
        <small>{operation.kind==='Taller'?`Pagado en caja: ${amount?money(amount.cashOut):'—'}`:'Salidas de caja de este alquiler'}</small></div>
      <div><dt>Cargos emitidos</dt><dd>{amount?money(amount.charged):'—'}</dd><small>{file?.documents?.length??0} documentos</small></div>
      <div><dt>Abonos aplicados</dt><dd className="amount-paid">{amount?money(amount.paid):'—'}</dd><small>Pagos reales vinculados</small></div>
      <div className="amount-outstanding"><dt>Por cobrar</dt><dd>{!amount?'—':amount.charged?money(amount.balance):'Sin cargo'}</dd><small>{amount?.unbilled?'Hay presupuesto aprobado por emitir':amount?.quote?.status==='Borrador'?'Presupuesto pendiente de aprobar':'Saldo de los cargos emitidos'}</small></div>
    </dl>
    {!!amount?.pendingCosts&&<p className="inline-note mx-4 mt-4">{amount.pendingCosts} costos por revisar: confirme si ya están incluidos, son adicionales o los asume el negocio.
      <Link className="text-link ml-2" href={href+'&seccion=Costos'}>Revisar en el folio →</Link></p>}
    {!!amount?.advances&&<p className="inline-note mx-4 mt-4">Anticipos vinculados sin aplicar: <strong>{money(amount.advances)}</strong>. Ya están recibidos; no los registre otra vez.</p>}
    {file?.documents?.some(d=>d.scope_balance>0&&d.due_on<localToday())&&<p className="inline-note mx-4 mt-4">Este trabajo tiene saldo vencido. La entrega no cierra su cuenta por cobrar.</p>}
    <div className="collection-actions"><Button variant="outline" size="sm" asChild><Link href={quoteHref}><FileText size={14}/>{amount?.quote?'Ver presupuesto':'Ver operación'}</Link></Button>
      {can('expenses.write')&&operation.kind==='Taller'&&<Button variant="outline" size="sm" onClick={()=>open('gasto',operation.id)}><Plus size={14}/>Registrar gasto</Button>}
      {can('expenses.write')&&operation.kind==='Taller'&&!operation.internal&&!!amount?.unbilled&&<Button size="sm" onClick={()=>setForm(form==='issue'?null:'issue')}>Crear cargo del presupuesto</Button>}
      {can('expenses.write')&&!operation.internal&&operation.customerId&&<Button size="sm" onClick={()=>setReceiptOpen(true)}><Wallet size={14}/>{payable.length?'Registrar abono':'Registrar anticipo'}</Button>}
      <Link className="collection-case-link" href={href}>Ver expediente<ArrowUpRight size={14}/></Link>
    </div>
    {form&&<form className="collection-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);
      const payload={orderId:operation.id,date:String(f.get('date')),dueOn:String(f.get('dueOn'))};
      void execute('bill_scope',payload,key=>caseCommand('bill_scope',payload,key))
        .then(saved=>{if(saved)setForm(null);});
    }}><h3>Crear el cargo pendiente del presupuesto</h3>
      <p>Importe pendiente de emitir: <strong>{money(amount?.unbilled??0)}</strong>. Esto registra una cuenta por cobrar, no una entrada de dinero.</p>
      <div className="form-grid"><label className="form-field"><span>Fecha del cargo</span><input name="date" type="date" defaultValue={localToday()} required/></label>
        <label className="form-field"><span>Fecha de vencimiento</span><input name="dueOn" type="date" defaultValue={localToday()} required/></label></div>
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}>{busy?'Guardando…':'Confirmar cargo'}</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>setForm(null)}>Cancelar</Button></div>
    </form>}
    {file&&<details className="collection-breakdown"><summary>Ver cargos, abonos y gastos</summary>
      {!!file.documents?.length&&<AdaptiveTable><thead><tr><th>Cargo</th><th>Importe</th><th>Saldo</th></tr></thead><tbody>{file.documents.map(d=><tr key={d.id}><td>{d.description}<small>{folio('CAR',d.folio_number)}</small></td><td>{money(d.scope_amount)}</td><td>{money(d.scope_balance)}</td></tr>)}</tbody></AdaptiveTable>}
      {!file.documents?.length&&<p>Todavía no hay cargos emitidos para esta operación.</p>}
      <h3 className="font-semibold mt-4">Abonos aplicados</h3>
      {(file.applications??[]).map(a=><p key={a.id}>{a.effective_on} · {a.kind==='Aplicacion'?'Abono aplicado':'Reversión de abono'} · <strong>{money(a.scope_amount)}</strong>
        <br/><Link className="text-link" href={diaryHref(operation.id,'receipt:'+a.payment_id,file.payments?.find(p=>p.id===a.payment_id)?.paid_on)}>Ver recibo original →</Link></p>)}
      {!file.applications?.length&&<p>No hay abonos aplicados a esta operación.</p>}
      {operation.kind==='Taller'&&<><h3 className="font-semibold mt-4">Costos del trabajo</h3>
        {(file.costs??[]).map(c=><p key={c.id}>{c.description} · <strong>{money(c.amount)}</strong></p>)}
        <p>Los costos incurridos y sus pagos de caja son el mismo hecho visto por separado: no deben sumarse entre sí.</p></>}
      <h3 className="font-semibold mt-4">Gastos efectivamente pagados</h3>
      {(file.expenses??[]).map(e=><p key={e.id}>{e.date} · {e.concept} · <strong>{money(e.scope_amount??e.amount)}</strong>{e.shared&&<> de un comprobante de {money(e.amount)}</>}
        <br/><Link className="text-link" href={diaryHref(operation.id,'expense:'+e.id,e.date)}>Ver gasto original →</Link></p>)}
      {!file.expenses?.length&&<p>No hay gastos de caja registrados para esta operación.</p>}
      <Link className="text-link" href={`/libro-diario/?operacion=${encodeURIComponent(operation.id)}`}>Ver movimientos en Libro diario →</Link>
    </details>}{receiptOpen&&<ReceiptDialog customerId={operation.customerId} orderId={operation.kind==='Taller'?operation.id:undefined}
      reservationId={operation.kind==='Alquiler'?operation.id:undefined} onChange={onChange} onClose={()=>setReceiptOpen(false)}/>}{error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </article>;
}
