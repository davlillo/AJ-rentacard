'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {ArrowLeft,Plus,Download,Trash2,Search,PencilLine} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {WorkbookPreview} from '@/components/organisms/workbook-preview';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {PresupuestosScreen} from './presupuestos-screen';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {additionalLineIndexes,budgetAdditionalItems,budgetDraftTotals,type AdditionalItems,type DraftKindTotals} from '@/controladores/budget-draft';
import {ADDITIONAL_REASON_HINT,RE_APPROVAL_NOTICE,clarityEmptyLine,clarityLabels,needsClientApproval,planAdditionalItem,type ClarityVersion} from '@/controladores/budget-clarity';
import {orderHref} from '@/lib/supabase/cases';
import {estimateCommand,loadEstimates,quotePdf,type QuoteVersion} from '@/lib/supabase/estimates';
import {VehicleImage} from '@/components/organisms/vehicle-image';
import {loadCase,type CaseFile} from '@/lib/supabase/cases';
import {workshopMoney} from '@/controladores/workshop-pipeline';
import {recordConnectedQuote} from '@/lib/supabase/connected-money';
import {BudgetCostOrigins} from '@/components/organisms/budget-cost-origins';
import styles from './operational-estimates.module.css';
import {Disclosure} from '@/components/organisms/disclosure';

export interface BudgetLine {description:string;kind:string;quantity:string;unitPrice:string;unitCost:string;sourceCostId?:string;sourceCostVersion?:number;}
const emptyLine=(kind='Material'):BudgetLine=>clarityEmptyLine(kind);
const kindLabel=(kind:string)=>kind==='Trabajo'?'Mano de obra':kind==='Tercero'?'Servicio externo':kind==='Indirecto'?'Otro costo':'Material';
// Plain labels for the money split. A kind that is zero prints no row at all.
const kindRows=(kinds:DraftKindTotals)=>[
  {label:'Repuestos (material)',amount:kinds.material},
  {label:'Mano de obra',amount:kinds.labor},
  {label:'Servicios externos',amount:kinds.thirdParty},
  {label:'Otros costos',amount:kinds.indirect},
].filter(row=>row.amount!==0);
const revisionState=(status:string)=>status==='Aprobado'?'aprobado':status==='Rechazado'?'rechazado':'pendiente de aprobación';
// One additional-item summary for the folio detail and for the editor: amounts and the
// state of the revision they belong to, plus the authorized costs left outside the scope.
function AdditionalSummary({items}:{items:AdditionalItems}){
  if(!items.lines.length&&!items.outside.length)return null;
  return <section className={styles.additionalBlock} aria-label="Adicionales del presupuesto">
    <h3>Adicionales</h3>
    <p className="field-hint">Partidas agregadas después del alcance inicial. Solo cuentan cuando su versión queda aprobada.</p>
    {!!items.lines.length&&<ul className={styles.additionalList}>{items.lines.map((item,index)=>
      <li key={item.quoteId+'-'+index}><span>{item.description}</span><span className={styles.additionalAmount}>{money(item.amount)}</span>
        <small>Versión {item.revision} · {revisionState(item.status)}</small></li>)}</ul>}
    {items.outside.map(cost=><p key={cost.costId} className={styles.outsideAdditional}>
      <strong>Adicional autorizado fuera del presupuesto:</strong> {cost.description} · {money(cost.amount)}.
      <span>No está incluido en el alcance aprobado; requiere una versión aprobada antes de cobrarse.</span></p>)}
  </section>;
}
const toSnapshotLine=(line:{description:string;quantity:number;unitPrice:number;unitCost:number|null})=>
  ({description:line.description,quantity:Number(line.quantity),unitPrice:Number(line.unitPrice),unitCost:line.unitCost===null?null:Number(line.unitCost)});
const snapshotAmount=(line:{kind:string;quantity:number;unitPrice:number;unitCost:number|null})=>
  ({kind:line.kind,quantity:String(line.quantity),unitPrice:String(line.unitPrice),unitCost:line.unitCost===null?'':String(line.unitCost)});

// What the editor starts from. The folio stage and the presupuestos workspace hand
// the same seed, so both open the same editor with the same canonical save.
export interface BudgetEditorSeed{
  lines:BudgetLine[];discount:string;parentId:string|null;section:'costs'|'pricing';
  internal?:boolean;customerId?:string;vehicleId?:string;service?:string;area?:string;
}

export function EstimatesScreen(){const {source}=useBusiness();return source==='supabase'?<BudgetWorkspace/>:<PresupuestosScreen/>;}
function BudgetWorkspace(){
  const {data,refresh,can,open,modal}=useBusiness();const [view,setView]=useState<'excel'|'list'|'edit'|'detail'>('list');
  const [quotes,setQuotes]=useState<QuoteVersion[]>([]);const [jobId,setJobId]=useState('');
  const [selected,setSelected]=useState('');
  const [loadError,setLoadError]=useState('');const [loading,setLoading]=useState(true);const [query,setQuery]=useState('');
  const [statusFilter,setStatusFilter]=useState('Todos');const [imageBusy,setImageBusy]=useState(false);const [imageError,setImageError]=useState('');
  const [caseFile,setCaseFile]=useState<CaseFile|null>(null);
  const [seed,setSeed]=useState<BudgetEditorSeed|null>(null);
  const [approval,setApproval]=useState(false);
  const quoteRead=useRef(0);const initialized=useRef(false);
  const [additionalHint,setAdditionalHint]=useState(false);
  const quote=quotes.find(q=>q.id===selected);
  const contextOrder=quote?.order_id??jobId;
  const job=data.orders.find(o=>o.id===contextOrder);
  const existing=job;
  const latest=quotes.filter(q=>q.order_id===contextOrder).sort((a,b)=>b.revision-a.revision)[0];
  const internal=job?.internalJob??!!seed?.internal;
  const reload=useCallback(async()=>{if(!can('expenses.read'))return;const revision=++quoteRead.current;const result=await loadEstimates();
    if(revision===quoteRead.current)setQuotes(result.quotes);await refresh();},[refresh]);
  const {execute,busy,error}=useCaseAction(reload);
  useEffect(()=>{let active=true;
    const contextVehicle=quote?.vehicle_snapshot.id??existing?.vehicleId;const contextOrderId=quote?.order_id??existing?.id;
     if(!can('expenses.read')||(view!=='detail'&&view!=='edit')||!contextVehicle||!contextOrderId){setCaseFile(null);return;}
    setCaseFile(null);void loadCase(contextVehicle,contextOrderId).then(file=>{if(active)setCaseFile(file);})
      .catch(error=>{if(active)setLoadError(error.message);});return()=>{active=false;};
  },[view,quote?.id,quote?.status,existing?.id,existing?.vehicleId,modal.kind,data]);
   useEffect(()=>{let active=true;const revision=++quoteRead.current;if(!can('expenses.read'))return;void loadEstimates().then(result=>{
    if(!active||revision!==quoteRead.current)return;setQuotes(result.quotes);setLoading(false);setLoadError('');
    // A shared refresh updates server facts, never the user's current draft or view.
    if(initialized.current)return;initialized.current=true;
    const params=new URLSearchParams(window.location.search);
    setAdditionalHint(params.get('adicional')==='1');
    const id=params.get('id');const initial=result.quotes.find(q=>q.id===id);
    if(initial){setSelected(initial.id);setJobId(initial.order_id);setView('detail');}
    const orderId=params.get('trabajo');const order=data.orders.find(o=>o.id===orderId);
     if(!initial&&order){
      const previous=result.quotes.filter(q=>q.order_id===order.id).sort((a,b)=>b.revision-a.revision)[0];
      setJobId(order.id);setView('edit');
      setSeed({parentId:previous?.id??null,discount:String(previous?.snapshot.discount??0),section:'costs',
        internal:!!order.internalJob,customerId:order.customerId??'',vehicleId:order.vehicleId,
        service:order.service,area:order.area,
        lines:previous?previous.snapshot.lines.map(l=>({description:l.description,kind:l.kind,quantity:String(l.quantity),
          unitPrice:String(l.unitPrice),unitCost:l.unitCost===null?'':String(l.unitCost)})):[emptyLine()]});
    }
  }).catch(error=>{if(active&&revision===quoteRead.current){setLoadError(error.message);setLoading(false);}});
    return()=>{active=false;if(revision===quoteRead.current)quoteRead.current++;};},[data]);
  // The ?adicional=1 hint opens the extra-item flow straight away: the latest quote of the
  // referenced work is copied into a new revision with one empty line ready to fill.
  useEffect(()=>{if(!additionalHint||loading||!quotes.length)return;
    const params=new URLSearchParams(window.location.search);
    const id=params.get('id');const trabajo=params.get('trabajo');
    const target=id?quotes.find(q=>q.id===id):trabajo?quotes.filter(q=>q.order_id===trabajo).sort((a,b)=>b.revision-a.revision)[0]:undefined;
    if(!target)return;
    setAdditionalHint(false);
    startAdditional(target);
  },[additionalHint,loading,quotes]);
  function seedFor(version?:QuoteVersion){
    const orderId=version?.order_id;
    if(version)version=quotes.filter(q=>q.order_id===orderId).sort((a,b)=>b.revision-a.revision)[0]??version;
    const order=data.orders.find(o=>o.id===version?.order_id);
    return{parentId:version?.id??null,discount:String(version?.snapshot.discount??0),section:'costs' as const,
      internal:!!order?.internalJob,customerId:order?.customerId??'',vehicleId:order?.vehicleId??'',
      service:order?.service??'',area:order?.area??'Mecánica',
      lines:version?version.snapshot.lines.map(l=>({description:l.description,kind:l.kind,quantity:String(l.quantity),
        unitPrice:String(l.unitPrice),unitCost:l.unitCost===null?'':String(l.unitCost)})):[emptyLine()]};
  }
  function start(version?:QuoteVersion){setJobId(version?.order_id??'');setSelected('');setSeed(seedFor(version));setView('edit');}
   // An extra item is a new full-scope revision of the latest quote: the saved scope is
   // copied, one empty line waits for the operator and the client price is written by hand.
   function startAdditional(version:QuoteVersion){
     const latestQuote=quotes.filter(q=>q.order_id===version.order_id).sort((a,b)=>b.revision-a.revision)[0]??version;
     const order=data.orders.find(o=>o.id===latestQuote.order_id);
     const plan=planAdditionalItem({id:latestQuote.id,revision:latestQuote.revision,status:latestQuote.status,
       snapshot:{lines:latestQuote.snapshot.lines.map(l=>({description:l.description,kind:l.kind,quantity:Number(l.quantity),
         unitPrice:Number(l.unitPrice),unitCost:l.unitCost===null?null:Number(l.unitCost)}))}},versions);
     setJobId(latestQuote.order_id);
     setSeed({...seedFor(latestQuote),lines:plan.lines,parentId:plan.parentId,
       section:order?.internalJob?'costs':'pricing'});
     setView('edit');
  }
  function show(version:QuoteVersion){setJobId(version.order_id);setSelected(version.id);setApproval(false);setView('detail');}
  const versions:ClarityVersion[]=quotes.map(q=>({id:q.id,parent_id:q.parent_id,status:q.status}));
  const latestQuotes=quotes.filter(q=>!quotes.some(other=>other.order_id===q.order_id&&other.revision>q.revision))
    .filter(q=>`${q.vehicle_snapshot.plate} ${q.vehicle_snapshot.model} ${q.customer_snapshot.name} ${folio('PRE',q.folio_number)} ${data.orders.find(o=>o.id===q.order_id)?.service??''}`.toLowerCase().includes(query.toLowerCase()))
    .filter(q=>statusFilter==='Todos'||q.status===statusFilter);
  const page=usePagination(latestQuotes,query+statusFilter);
  const detailReApproval=quote&&quote.status!=='Aprobado'&&needsClientApproval(versions,quote.id)?RE_APPROVAL_NOTICE:null;
  // The folio detail reads the split and the additional items from the saved versions
  // of this work only. Nothing is recomputed into a second total.
  const orderQuotes=quotes.filter(q=>q.order_id===contextOrder);
  const detailTotals=quote?budgetDraftTotals(quote.snapshot.lines.map(snapshotAmount),String(quote.snapshot.discount)):null;
  const detailAdded=new Set(quote?additionalLineIndexes(quote.snapshot.lines.map(toSnapshotLine),
    (orderQuotes.find(version=>version.id===quote.parent_id)?.snapshot.lines??[]).map(toSnapshotLine)):[]);
  const detailAdditional=budgetAdditionalItems(orderQuotes.map(version=>({id:version.id,revision:version.revision,
    parent_id:version.parent_id,status:version.status,snapshot:{lines:version.snapshot.lines.map(toSnapshotLine)}})),
    (caseFile?.costs??[]).filter(cost=>cost.order_id===contextOrder).map(cost=>({id:cost.id,description:cost.description,
      amount:cost.amount,disposition:cost.disposition,estimate_id:cost.estimate_id})));
  if(!can('expenses.read')||caseFile?.financialAccess===false)return <p className="inline-note">Información financiera restringida.</p>;
  return <><PageHeading title="Presupuestos"/>
    <div className="module-toolbar"><nav className="module-tabs" aria-label="Vista de presupuestos"><button className={view!=='excel'?'active':''} onClick={()=>setView('list')}>Lista</button></nav>
     <div className="heading-actions">{view==='detail'&&quote&&<Button variant="outline" size="icon" className="compact-edit"
       aria-label={`Editar presupuesto ${folio('PRE',quote.folio_number)}`} data-tooltip="Editar presupuesto"
       disabled={busy||!can('expenses.write')||job?.status==='Entregado'} onClick={()=>start(quote)}><PencilLine size={17} aria-hidden="true"/></Button>}
      {view==='detail'&&quote&&!internal&&<Button variant="outline" disabled={busy||!can('expenses.write')||job?.status==='Entregado'}
       onClick={()=>startAdditional(quote)}><Plus size={16}/>Agregar adicional al cliente</Button>}
       {view!=='edit'&&<Button variant={view==='detail'?'outline':'default'} disabled={!can('expenses.write')} onClick={()=>start()}><Plus size={16}/>Nuevo presupuesto</Button>}
       {view==='excel'?<Button variant="ghost" size="sm" onClick={()=>setView('list')}>Volver a la lista</Button>:
        <Button variant="ghost" size="sm" onClick={()=>setView('excel')}>Archivo original</Button>}</div></div>
    {view==='excel'&&<WorkbookPreview format="budget"/>}
    {view==='list'&&<><div className="quote-list-tools"><div className="search-field"><Search size={16}/><input aria-label="Buscar presupuesto" placeholder="Folio, cliente o vehículo" value={query} onChange={e=>setQuery(e.target.value)}/></div>
      <label className="form-field"><span>Estado del presupuesto</span><select aria-label="Estado del presupuesto" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
        {['Todos','Borrador','Aprobado','Rechazado'].map(value=><option key={value}>{value}</option>)}</select></label></div>
      <section className="panel"><AdaptiveTable className="quote-index-table"><thead><tr><th>Presupuesto / cliente</th><th>Vehículo y trabajo</th><th>Estado</th><th>Total</th><th/></tr></thead>
        <tbody>{page.items.map(q=>{const quotedJob=data.orders.find(o=>o.id===q.order_id);return <tr key={q.id}>
          <td><button className="text-link folio-link" onClick={()=>show(q)}>{folio('PRE',q.folio_number)}</button><small>{q.customer_snapshot.name||'Mantenimiento interno'}</small></td>
          <td><div className="quote-vehicle-cell"><VehicleImage vehicleId={q.vehicle_snapshot.id} plate={q.vehicle_snapshot.plate}
            fileId={data.vehicles.find(v=>v.id===q.vehicle_snapshot.id)?.primaryPhotoId} size="thumbnail"/>
            <div><strong>{q.vehicle_snapshot.brand} {q.vehicle_snapshot.model} {q.vehicle_snapshot.year}</strong><small>{q.vehicle_snapshot.plate||'Placa sin registrar'} · {quotedJob?.service}</small></div></div></td>
          <td><Badge tone={q.status==='Aprobado'?'green':q.status==='Rechazado'?'red':'amber'}>{q.status}</Badge></td>
          <td><strong>{quotedJob?.internalJob?(q.snapshot.costComplete===false?clarityLabels.missingCost:money(q.snapshot.cost)):money(q.snapshot.total)}</strong>{quotedJob?.internalJob&&<small>{clarityLabels.internalCost}</small>}</td>
          <td><div className="flex flex-wrap gap-2"><Button variant="outline" size="icon" className="compact-edit"
            aria-label={`Editar presupuesto ${folio('PRE',q.folio_number)}`} data-tooltip="Editar presupuesto"
            disabled={busy||!can('expenses.write')||quotedJob?.status==='Entregado'} onClick={()=>start(q)}><PencilLine size={17} aria-hidden="true"/></Button>
            <Button variant="ghost" size="sm" className="whitespace-normal h-auto min-h-10 max-w-full" onClick={()=>show(q)}>Ver detalle</Button></div></td></tr>;})}</tbody></AdaptiveTable>
        {loading?<p role="status" className="module-loading">Cargando presupuestos…</p>:!latestQuotes.length&&<p className="module-empty">Todavía no hay presupuestos. Seleccione «Nuevo presupuesto» para preparar uno.</p>}
        <Pagination {...page}/></section></>}
     {view==='edit'&&seed&&<><button className="budget-back" onClick={()=>setView('list')}><ArrowLeft size={14}/>Volver a presupuestos</button>
       {existing&&<Link className={`text-link ${styles.contextBack}`} href={orderHref(existing.id)+'&seccion='+encodeURIComponent('Presupuestos')}>Volver al folio de taller · {folio('OT',existing.id)} →</Link>}
       <BudgetEditor key={seed.parentId??'new'} orderId={jobId||existing?.id||''} seed={seed} seedVersion={latest} versions={versions}
         caseFile={caseFile} onChange={async()=>{await reload();}}
         onSaved={saved=>{setQuotes(current=>[saved,...current.filter(q=>q.id!==saved.id)]);show(saved);}}/>
     </>}
    {view==='detail'&&quote&&<><button className="budget-back" onClick={()=>setView('list')}><ArrowLeft size={14}/>Volver a presupuestos</button><section className="budget-paper">
      <div className="budget-document-brand"><div className="document-logo">AJ<span>RENT A CAR</span></div><div><span>Presupuesto de servicio</span><strong>{folio('PRE',quote.folio_number)}</strong></div></div>
      <div className="budget-paper-heading"><div className="budget-client-vehicle"><VehicleImage vehicleId={quote.vehicle_snapshot.id} plate={quote.vehicle_snapshot.plate}
        fileId={data.vehicles.find(v=>v.id===quote.vehicle_snapshot.id)?.primaryPhotoId} size="thumbnail"/>
        <div><span className="document-folio">CLIENTE</span><h2>{quote.customer_snapshot.name||'Mantenimiento interno'}</h2><p>{quote.vehicle_snapshot.brand} {quote.vehicle_snapshot.model} {quote.vehicle_snapshot.year} · {quote.vehicle_snapshot.plate||'Placa sin registrar'}</p><p>{job?.service}</p></div></div>
        <Badge tone={quote.status==='Aprobado'?'green':quote.status==='Rechazado'?'red':'amber'}>{quote.status}</Badge></div>
      <p className="inline-note mb-5">Versión {quote.revision} · Folio de taller <strong>{quote.order_id}</strong>. Use «Editar presupuesto» para agregar o cambiar partidas.
        Los cambios se guardan como una nueva versión del mismo trabajo, sin duplicar gastos ni cobros.
        {latest&&latest.id!==quote.id&&' Hay una versión más reciente; la edición tomará esa última versión para no perder partidas.'}</p>
      {detailReApproval&&<p className="inline-note" role="status"><strong>Requiere una nueva aprobación del cliente.</strong> {detailReApproval} Guardar esta versión no la aprueba ni emite cobros.</p>}
      <AdaptiveTable><thead><tr><th>Descripción</th><th>Tipo</th><th>Cantidad</th><th>{internal?clarityLabels.internalCost:'Precio unitario'}</th><th>Importe</th></tr></thead><tbody>{quote.snapshot.lines.map((l,i)=><tr key={i}><td><strong>{l.description}</strong>{detailAdded.has(i)&&<> <Badge tone="amber">Adicional</Badge></>}</td><td>{kindLabel(l.kind)}</td><td>{l.quantity}</td><td>{internal?(l.unitCost===null?clarityLabels.missingCost:money(l.unitCost)):money(l.unitPrice)}</td><td><strong>{internal?(l.cost===null?clarityLabels.missingCost:money(l.cost)):money(l.price)}</strong></td></tr>)}</tbody></AdaptiveTable>
      <div className="budget-tally">{!internal&&<><div><span>Subtotal</span><strong>{money(quote.snapshot.subtotal)}</strong></div>
        {detailTotals&&kindRows(detailTotals.priceByKind).map(row=><div key={row.label} className={styles.kindRow}><span>{row.label}</span><strong>{money(row.amount)}</strong></div>)}
        <div><span>Descuento</span><strong>{money(quote.snapshot.discount)}</strong></div></>}<div className="grand-total"><span>{internal?clarityLabels.internalCost:'Total'}</span><strong>{internal?(quote.snapshot.costComplete===false?clarityLabels.missingCost:money(quote.snapshot.cost)):money(quote.snapshot.total)}</strong></div></div>
      {!internal&&<AdditionalSummary items={detailAdditional}/>}
      {quote.source_totals&&<aside className="source-reconciliation"><h3>Resumen anotado en el original</h3><dl><div><dt>Inicial + adicionales</dt><dd>{money(quote.source_totals.initial)} + {money(quote.source_totals.additional)}</dd></div><div><dt>Abono anotado</dt><dd>{money(quote.source_totals.advanceNotPosted)}</dd></div><div><dt>Saldo anotado</dt><dd>{money(quote.source_totals.balanceNotPosted)}</dd></div></dl><p>El abono y el saldo se conservan como referencia: no se han registrado como cobro ni deuda.</p></aside>}
      <p className="text-sm muted mt-4">{quote.reason}</p>
      <div className="budget-actions">{can('expenses.write')&&quote.status==='Borrador'&&quote.id===latest?.id&&job?.status!=='Entregado'&&<Button onClick={()=>setApproval(!approval)}>Aprobar presupuesto</Button>}
        {!internal&&<Button variant="outline" disabled={busy} onClick={()=>{void execute('quote.pdf',{id:quote.id,status:quote.status},async()=>{
          const pdf=await import('@/lib/documents/pdf');let stored=await quotePdf(quote);
          if(!stored)stored=await quotePdf(quote,pdf.bytesToBase64(await pdf.createBusinessPdf(pdf.quoteDocumentContent(quote),await pdf.browserFont())));
          if(stored)pdf.downloadPdf(stored.base64,`${folio('PRE',quote.folio_number)}-V${quote.revision}.pdf`);
        });}}><Download size={15}/>Descargar PDF</Button>}
      {!internal&&<Button variant="outline" disabled={imageBusy||busy} onClick={()=>{setImageBusy(true);setImageError('');
          void Promise.all([import('@/lib/documents/pdf'),import('@/lib/documents/quote-image')]).then(async([pdf,image])=>{
            await image.downloadQuoteImages(pdf.quoteDocumentContent(quote),`${folio('PRE',quote.folio_number)}-V${quote.revision}`);
          }).catch(error=>setImageError(error.message)).finally(()=>setImageBusy(false));
         }}><Download size={15}/>{imageBusy?'Preparando imagen…':'Descargar imagen para el cliente'}</Button>}
      </div>
       {!internal&&<p className="field-hint mt-4">La descarga contiene solo información del cliente y precios. No registra envío ni aprobación.</p>}
       {approval&&can('expenses.write')&&quote.id===latest?.id&&quote.status==='Borrador'&&job?.status!=='Entregado'&&<form className="operation-form mt-5" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);const payload={estimateId:quote.id,approverName:String(f.get('name')),evidence:String(f.get('evidence'))};
        void execute('approve',payload,key=>estimateCommand('approve',payload,key)).then(saved=>{if(saved)setApproval(false);});
      }}><label className="form-field"><span>Persona que aprueba</span><input name="name" required/></label><label className="form-field"><span>Confirmación del cliente</span><textarea name="evidence" required placeholder="Acuerdo por escrito, mensaje o autorización"/></label><Button type="submit" disabled={busy}>Confirmar aprobación</Button></form>}
      <Disclosure label="Versiones y costos internos" hint="Interno · no se muestra al cliente"><div className="operation-form mt-4"><label className="form-field"><span>Versión</span><select aria-label="Versión del presupuesto" value={selected} onChange={e=>{setSelected(e.target.value);setApproval(false);}}>
        {quotes.filter(q=>q.order_id===quote.order_id).sort((a,b)=>b.revision-a.revision).map(q=><option key={q.id} value={q.id}>{folio('PRE',q.folio_number)} · Versión {q.revision} · {q.status}</option>)}</select></label>
        <p className="text-sm">{clarityLabels.internalCost}: {quote.snapshot.costComplete===false?clarityLabels.missingCost:money(quote.snapshot.cost)}</p></div></Disclosure>
       {caseFile&&<section className="budget-operation-money"><h3>Seguimiento de este trabajo</h3><dl className="operation-amounts">
         {!internal&&<><div><dt>Importe a cobrar · emitido</dt><dd>{money(workshopMoney(caseFile,quote.order_id).charged)}</dd></div>
         <div><dt>Cobros aplicados</dt><dd className="amount-paid">{money(workshopMoney(caseFile,quote.order_id).paid)}</dd></div>
         <div><dt>Saldo pendiente</dt><dd>{workshopMoney(caseFile,quote.order_id).charged?money(workshopMoney(caseFile,quote.order_id).balance):'Sin importe emitido'}</dd></div></>}</dl>
         <div className="case-money-links">{!internal&&<Link href={orderHref(quote.order_id)+'&seccion='+encodeURIComponent('Cobros')}>Ver cobros de este trabajo →</Link>}
          <Link href={`/libro-diario/?operacion=${encodeURIComponent(quote.order_id)}`}>Ver libro diario →</Link>
          <Link href={orderHref(quote.order_id)+'&seccion='+encodeURIComponent('Costos')}>Registrar costos en el folio del trabajo →</Link></div></section>}
      <div className="budget-related"><Link className="text-link" href={orderHref(quote.order_id)}>Abrir expediente del trabajo →</Link><span>{job?.status==='Presupuesto'?'Recepción física pendiente':job?.status}</span></div>
    </section></>}
    {(error||loadError||imageError)&&<p role="alert" className="form-error mt-4">{error||loadError||imageError}</p>}
  </>;
}

// The cost-first budget editor. It owns its draft, but the save stays the canonical
// workshop.quote command with its idempotency key, its parent revision and the
// re-approval notice, so the folio stage and the workspace cannot diverge.
export function BudgetEditor({orderId,seed,seedVersion,versions=[],caseFile,onChange,onSaved,onClosed}:{
  orderId:string;seed:BudgetEditorSeed;seedVersion?:QuoteVersion;versions?:ClarityVersion[];
  caseFile?:CaseFile|null;onChange?:()=>Promise<void>;onSaved:(quote:QuoteVersion)=>void;onClosed?:()=>void;
}){
  const {data,can,open}=useBusiness();
  // Only a quote created from the bare workspace has no work order; the folio stage
  // always identifies the job, so its identity is taken from the order itself.
  const job=data.orders.find(o=>o.id===orderId);
  const [lines,setLines]=useState<BudgetLine[]>(seed.lines);
  const [discount,setDiscount]=useState(seed.discount);
  const [reason,setReason]=useState('');
  const [editorSection,setEditorSection]=useState<'costs'|'pricing'>(seed.section);
  const [customerId,setCustomerId]=useState(seed.customerId??job?.customerId??'');
  const [vehicleId,setVehicleId]=useState(seed.vehicleId??job?.vehicleId??'');
  const [service,setService]=useState(seed.service??job?.service??'');
  const [area,setArea]=useState(seed.area??job?.area??'Mecánica');
  const [internalDraft,setInternalDraft]=useState(!!(seed.internal??job?.internalJob));
  const [revisionParent,setRevisionParent]=useState<string|null>(seed.parentId);
  const [quotes,setQuotes]=useState<QuoteVersion[]>(seedVersion?[seedVersion]:[]);
  const [loadError,setLoadError]=useState('');
  const read=useRef(0);
  useEffect(()=>{let active=true;const revision=++read.current;
    if(!can('expenses.read'))return;
    void loadEstimates().then(result=>{if(!active||revision!==read.current)return;setQuotes(result.quotes);setLoadError('');})
      .catch(error=>{if(active)setLoadError(error.message);});
    return()=>{active=false;};},[]);
  const existing=job??data.orders.find(o=>o.vehicleId===vehicleId&&o.status!=='Entregado');
  const internal=job?.internalJob??internalDraft;
  const own=quotes.filter(q=>q.order_id===existing?.id).sort((a,b)=>b.revision-a.revision);
  const latest=own[0];
  const mismatched=existing&&(existing.internalJob!==internal||(!internal&&existing.customerId!==customerId));
  const needsExistingScope=!!latest&&!mismatched&&revisionParent!==latest.id;
  const versionsLocal:ClarityVersion[]=quotes.length?quotes.map(q=>({id:q.id,parent_id:q.parent_id,status:q.status})):versions;
  const reApproval=needsClientApproval(versionsLocal,revisionParent)?RE_APPROVAL_NOTICE:null;
  const totals=budgetDraftTotals(lines,discount,internal);
  // An extra line is the one appended after the copied scope of its parent revision.
  // The prefix check inside additionalLineIndexes keeps edited scopes from being labelled.
  const parentQuote=quotes.find(version=>version.id===revisionParent);
  const addedIndexes=new Set(additionalLineIndexes(lines.map(line=>({description:line.description,
    quantity:Number(line.quantity)||0,unitPrice:Number(line.unitPrice)||0,unitCost:line.unitCost===''?null:Number(line.unitCost)})),
    (parentQuote?.snapshot.lines??[]).map(toSnapshotLine)));
  const savedAdditional=budgetAdditionalItems(quotes.filter(version=>version.order_id===existing?.id).map(version=>({
    id:version.id,revision:version.revision,parent_id:version.parent_id,status:version.status,
    snapshot:{lines:version.snapshot.lines.map(toSnapshotLine)}})),
    (caseFile?.costs??[]).filter(cost=>cost.order_id===existing?.id).map(cost=>({id:cost.id,
      description:cost.description,amount:cost.amount,disposition:cost.disposition,estimate_id:cost.estimate_id})));
  const {execute,busy,error}=useCaseAction(onChange??(async()=>{}));
  function change(index:number,key:keyof Omit<BudgetLine,'sourceCostId'|'sourceCostVersion'>,value:string){setLines(lines.map((line,i)=>i===index?{...line,[key]:value}:line));}
  function continueLatest(version:QuoteVersion){
    setRevisionParent(version.id);setDiscount(String(version.snapshot.discount));
    setLines(version.snapshot.lines.map(l=>({description:l.description,kind:l.kind,quantity:String(l.quantity),
      unitPrice:String(l.unitPrice),unitCost:l.unitCost===null?'':String(l.unitCost)})));
  }
  function chooseVehicle(id:string){
    const order=data.orders.find(o=>o.vehicleId===id&&o.status!=='Entregado');
    const previous=quotes.filter(q=>q.order_id===order?.id).sort((a,b)=>b.revision-a.revision)[0];
    if(previous&&order?.internalJob===internal&&((internal)||order.customerId===customerId)){continueLatest(previous);return;}
    setVehicleId(id);
  }
  return <>
    <nav className={styles.contextTabs} aria-label="Costos previstos y presupuesto">
      <button type="button" aria-pressed={editorSection==='costs'} onClick={()=>setEditorSection('costs')}>1. Costos previstos · internos</button>
      {!internal&&<button type="button" aria-pressed={editorSection==='pricing'} onClick={()=>setEditorSection('pricing')}>2. Precio del presupuesto · cliente</button>}
    </nav>
    <aside className={styles.costContext} aria-label="Contexto de costos previstos">
      <p><strong>{clarityLabels.internalCost}: {totals.costComplete?money(totals.cost):clarityLabels.missingCost}</strong></p>
      <p>{internal?'Estimación interna del mantenimiento. No es una venta.':editorSection==='costs'?
        'Registre recursos y costos estimados desde el diagnóstico. Luego defina el precio al cliente; no se calcula un margen automático.':
        'Los costos internos permanecen visibles mientras define manualmente el precio al cliente. Cambiar un costo no cambia ese precio.'}</p>
      <Disclosure label="Ver costos internos de esta partida">
         {lines.filter(line=>line.description).map((line,index)=><p key={index}>{line.description} · {line.quantity} × {line.unitCost===''?clarityLabels.missingCost:money(Number(line.unitCost))}</p>)}
       </Disclosure>
    </aside>
     <form className={`budget-paper ${styles.editor}`} onSubmit={event=>{
      event.preventDefault();
      if(!can('expenses.write')||needsExistingScope||!existing?.id)return;
      const payload={orderId:existing.id,vehicleId,customerId:internal?null:customerId,service,area,internalJob:internal,
        parentId:revisionParent,reason:reason.trim()||'Presupuesto inicial',discount:internal?'0':discount,
        lines:lines.map(l=>({...l,unitPrice:internal?'0':l.unitPrice,unitCost:l.unitCost||null}))};
      void execute('workshop.quote',payload,key=>recordConnectedQuote(payload,key).then(saved=>{onSaved(saved);}));
     }}><fieldset disabled={busy||!can('expenses.write')} className="contents"><div className="budget-paper-heading"><div><h2>{latest?'Editar presupuesto':'Nuevo presupuesto'}</h2><p>{internal?'Estime los costos del mantenimiento.':'Estime los costos y defina el precio al cliente. Los costos y el margen son internos.'} Importes en USD.</p></div><Badge tone="gray">Borrador</Badge></div>
      {latest&&<p className="inline-note">Agregue, cambie o quite partidas. Se guardará una nueva versión del mismo folio de taller <strong>{existing?.id}</strong>, conservando el presupuesto anterior, sus gastos, cargos y abonos. La revisión queda en borrador: no crea un cargo ni registra dinero.</p>}
      {reApproval&&<p className="inline-note" role="status"><strong>Requiere una nueva aprobación del cliente.</strong> {reApproval} Guardar esta versión no la aprueba ni emite cobros.</p>}
      {!job&&<label className="budget-internal"><input type="checkbox" checked={internalDraft} onChange={e=>{setInternalDraft(e.target.checked);setVehicleId('');}}/> Mantenimiento interno de la flota</label>}
       <div className="form-grid budget-identity">
        {!internal&&<label className="form-field"><span>Cliente *</span><select aria-label="Cliente del presupuesto" required disabled={!!job} value={customerId} onChange={e=>setCustomerId(e.target.value)}>
          <option value="">Seleccionar cliente</option>{data.customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {!job&&<button type="button" className="text-link" onClick={()=>open('cliente')}>Agregar cliente</button>}</label>}
        <label className="form-field"><span>Vehículo *</span><select aria-label="Vehículo del presupuesto" required disabled={!!job} value={vehicleId} onChange={e=>chooseVehicle(e.target.value)}>
          <option value="">Seleccionar vehículo</option>{data.vehicles.filter(v=>v.id===job?.vehicleId||(internal?v.inRentalFleet:!v.inRentalFleet&&v.ownership!=='Propio')).map(v=><option key={v.id} value={v.id}>{v.plate||'Sin placa'} · {v.brand} {v.model} {v.year}</option>)}</select>
          {!job&&<button type="button" className="text-link" onClick={()=>open('vehiculo','client')}>Agregar vehículo</button>}</label>
         <label className="form-field"><span>Trabajo a realizar *</span><input aria-label="Trabajo del presupuesto" required disabled={!!job} maxLength={2000} value={service} onChange={e=>setService(e.target.value)} placeholder="Ej. reparación de la parte delantera"/></label>
         <label className="form-field"><span>Área</span><select aria-label="Área del presupuesto" disabled={!!job} value={area} onChange={e=>setArea(e.target.value)}><option>Mecánica</option><option>Pintura</option></select></label>
       </div>
      {mismatched&&<p className="form-error" role="alert">Este vehículo tiene un trabajo abierto para otro cliente. Revise su expediente antes de continuar.</p>}
      {existing&&!job&&!mismatched&&<p className="field-hint">El presupuesto quedará vinculado al trabajo existente: {existing.service}.</p>}
      {needsExistingScope&&<div className="inline-note"><p>Cargue la última versión antes de continuar para conservar sus partidas.</p>
        <Button type="button" variant="outline" className="mt-3" onClick={()=>latest&&continueLatest(latest)}>Continuar presupuesto existente</Button></div>}
       {caseFile&&existing&&!mismatched&&<BudgetCostOrigins file={caseFile} orderId={existing.id} selected={lines.flatMap(l=>l.sourceCostId?[l.sourceCostId]:[])} onAdd={cost=>{
        const added:BudgetLine={description:cost.description,kind:'Indirecto',quantity:String(cost.quantity),unitPrice:'',unitCost:String(cost.unit_cost),sourceCostId:cost.id,sourceCostVersion:cost.version};
        setLines(current=>current.length===1&&!current[0].description&&!current[0].unitPrice?[added]:[...current,added]);
      }}/>}
       <div className="budget-line-list" aria-label="Partidas del presupuesto">{lines.map((line,index)=><div className={`budget-line ${internal?styles.internalLine:''}`} key={index}>
         <label className="form-field budget-line-description"><span>Descripción {index+1} *</span><input aria-label={`Descripción ${index+1}`} required value={line.description} onChange={e=>change(index,'description',e.target.value)} placeholder="Repuesto, material o trabajo"/>
           {(addedIndexes.has(index)||!!line.sourceCostId)&&<small className={styles.additionalTag}>Adicional</small>}</label>
        <label className="form-field"><span>Tipo</span><select aria-label={`Tipo ${index+1}`} value={line.kind} onChange={e=>change(index,'kind',e.target.value)}>{['Material','Trabajo','Tercero','Indirecto'].map(kind=><option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select></label>
        <label className="form-field"><span>Cantidad *</span><input aria-label={`Cantidad ${index+1}`} type="number" step="0.0001" min="0.0001" required value={line.quantity} onChange={e=>change(index,'quantity',e.target.value)}/></label>
         <label className="form-field"><span>{clarityLabels.internalUnitCost}</span><input aria-label={`Costo unitario ${index+1}`} type="number" step="0.0001" min="0" value={line.unitCost} onChange={e=>change(index,'unitCost',e.target.value)} placeholder={clarityLabels.missingCost}/></label>
          {!internal&&(editorSection==='pricing'?<label className="form-field"><span>Precio al cliente *</span><input aria-label={`Precio unitario ${index+1}`} type="number" step="0.0001" min="0" required value={line.unitPrice} onChange={e=>change(index,'unitPrice',e.target.value)} placeholder="Definir precio"/></label>:
            <div className="form-field"><span>Precio al cliente · manual</span><strong>{line.unitPrice===''?clarityLabels.missingPrice:money(Number(line.unitPrice))}</strong></div>)}
         <div className="budget-line-total"><span>Importe</span><strong>{internal?(totals.costs[index]===null?clarityLabels.missingCost:money(totals.costs[index]!)):line.unitPrice===''?clarityLabels.missingPrice:money(totals.prices[index])}</strong></div>
         <Button type="button" variant="ghost" size="icon" disabled={lines.length===1} aria-label={`Quitar partida ${index+1}`} onClick={()=>setLines(lines.filter((_,i)=>i!==index))}><Trash2 size={15}/></Button>
         {line.sourceCostId&&<p className="budget-line-cost">Vinculado a un costo existente del trabajo. Complete el precio al cliente; no se registra otra salida de caja.</p>}
      </div>)}</div>
       <div className="flex gap-3 mt-4 flex-wrap"><Button type="button" variant="default" size="sm" onClick={()=>setLines([...lines,emptyLine()])}><Plus size={14}/>Agregar partida (material o adicional)</Button>
        <Button type="button" variant="ghost" size="sm" onClick={()=>setLines([...lines,emptyLine('Trabajo')])}><Plus size={14}/>Agregar mano de obra</Button></div>
       <div className="budget-tally">{!internal&&<><div><span>{clarityLabels.internalCost}</span><strong>{totals.costComplete?money(totals.cost):clarityLabels.missingCost}</strong></div>
         <div><span>Subtotal al cliente</span><strong>{totals.priceComplete?money(totals.subtotal):clarityLabels.missingPrice}</strong></div>
         {totals.priceComplete&&kindRows(totals.priceByKind).map(row=><div key={row.label} className={styles.kindRow}><span>{row.label}</span><strong>{money(row.amount)}</strong></div>)}
         <div><label htmlFor="budget-discount">Descuento</label><input id="budget-discount" type="number" min="0" step="0.01" value={discount} onChange={e=>setDiscount(e.target.value)}/></div></>}
        {internal&&totals.costComplete&&kindRows(totals.costByKind).map(row=><div key={row.label} className={styles.kindRow}><span>{row.label}</span><strong>{money(row.amount)}</strong></div>)}
        <div className="grand-total"><span>{internal?clarityLabels.internalCost:'Total del presupuesto'}</span><strong>{internal?(totals.costComplete?money(totals.cost):clarityLabels.missingCost):totals.priceComplete?money(totals.total):clarityLabels.missingPrice}</strong></div>
        {!internal&&<div className={totals.margin!==null&&totals.margin<0?styles.loss:undefined}><span>{clarityLabels.internalMargin}</span><strong>{totals.margin===null?clarityLabels.missingCost:money(totals.margin)}</strong></div>}
        </div>
       {!internal&&<AdditionalSummary items={savedAdditional}/>}
       <label className="form-field"><span>Observaciones{latest?' / motivo del cambio *':''}</span><textarea value={reason} onChange={e=>setReason(e.target.value)} required={!!latest} placeholder="Alcance del trabajo, condiciones o motivo de esta versión"/></label>
       <p className="field-hint">{ADDITIONAL_REASON_HINT}</p>
        <div className="budget-actions">{onClosed&&<Button type="button" variant="outline" onClick={onClosed}>Cancelar</Button>}
          {!internal&&editorSection==='costs'?<Button type="button" onClick={()=>setEditorSection('pricing')}>Definir precio al cliente →</Button>:
            <Button type="submit" disabled={busy||!can('expenses.write')||!!mismatched||needsExistingScope||!vehicleId||(!internal&&(!customerId||!totals.priceComplete))}>{busy?'Guardando…':'Guardar presupuesto'}</Button>}</div>
    </fieldset></form>
    {loadError&&<p role="alert" className="form-error mt-4">{loadError}</p>}
    {error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </>;
}
