'use client';
import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {ArrowLeft,Plus,Download,Trash2,Search} from 'lucide-react';
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
import {budgetDraftTotals} from '@/controladores/budget-draft';
import {orderHref} from '@/lib/supabase/cases';
import {estimateCommand,loadEstimates,quotePdf,saveWorkshopQuote,type QuoteVersion} from '@/lib/supabase/estimates';

interface BudgetLine {description:string;kind:string;quantity:string;unitPrice:string;unitCost:string;}
const emptyLine=(kind='Material'):BudgetLine=>({description:'',kind,quantity:'1',unitPrice:'',unitCost:''});
const kindLabel=(kind:string)=>kind==='Trabajo'?'Mano de obra':kind==='Tercero'?'Servicio externo':kind==='Indirecto'?'Otro costo':'Material';

export function EstimatesScreen(){const {source}=useBusiness();return source==='supabase'?<BudgetWorkspace/>:<PresupuestosScreen/>;}
function BudgetWorkspace(){
  const {data,refresh,can,open}=useBusiness();const [view,setView]=useState<'excel'|'list'|'edit'|'detail'>('list');
  const [quotes,setQuotes]=useState<QuoteVersion[]>([]);const [jobId,setJobId]=useState('');
  const [customerId,setCustomerId]=useState('');const [vehicleId,setVehicleId]=useState('');
  const [service,setService]=useState('');const [area,setArea]=useState('Mecánica');const [internalDraft,setInternalDraft]=useState(false);
  const [selected,setSelected]=useState('');const [lines,setLines]=useState<BudgetLine[]>([emptyLine()]);
  const [discount,setDiscount]=useState('0');const [reason,setReason]=useState('');const [approval,setApproval]=useState(false);
  const [loadError,setLoadError]=useState('');const [loading,setLoading]=useState(true);const [query,setQuery]=useState('');
  const job=data.orders.find(o=>o.id===jobId);const quote=quotes.find(q=>q.id===selected);
  const existing=job??data.orders.find(o=>o.vehicleId===vehicleId&&o.status!=='Entregado');
  const latest=quotes.filter(q=>q.order_id===existing?.id).sort((a,b)=>b.revision-a.revision)[0];
  const internal=job?.internalJob??internalDraft;
  const reload=useCallback(async()=>{setQuotes((await loadEstimates()).quotes);await refresh();},[refresh]);
  const {execute,busy,error}=useCaseAction(reload);
  useEffect(()=>{let active=true;void loadEstimates().then(result=>{
    if(!active)return;setQuotes(result.quotes);setLoading(false);
    const id=new URLSearchParams(window.location.search).get('id');const initial=result.quotes.find(q=>q.id===id);
    if(initial){setSelected(initial.id);setJobId(initial.order_id);setView('detail');}
    const orderId=new URLSearchParams(window.location.search).get('trabajo');const order=data.orders.find(o=>o.id===orderId);
    if(!initial&&order){setJobId(order.id);setCustomerId(order.customerId??'');setVehicleId(order.vehicleId);
      setService(order.service);setArea(order.area);setInternalDraft(!!order.internalJob);setView('edit');}
  }).catch(error=>{if(active){setLoadError(error.message);setLoading(false);}});return()=>{active=false;};},[]);
  function start(version?:QuoteVersion){
    const order=data.orders.find(o=>o.id===version?.order_id);
    setJobId(order?.id??'');setCustomerId(order?.customerId??'');setVehicleId(order?.vehicleId??'');
    setService(order?.service??'');setArea(order?.area??'Mecánica');setInternalDraft(!!order?.internalJob);
    setSelected('');setDiscount(String(version?.snapshot.discount??0));setReason('');setApproval(false);
    setLines(version?version.snapshot.lines.map(l=>({description:l.description,kind:l.kind,quantity:String(l.quantity),
      unitPrice:String(l.unitPrice),unitCost:l.unitCost===null?'':String(l.unitCost)})):[emptyLine()]);setView('edit');
  }
  function change(index:number,key:keyof BudgetLine,value:string){setLines(lines.map((line,i)=>i===index?{...line,[key]:value}:line));}
  function show(version:QuoteVersion){setJobId(version.order_id);setSelected(version.id);setApproval(false);setView('detail');}
  const totals=budgetDraftTotals(lines,discount);
  const latestQuotes=quotes.filter(q=>!quotes.some(other=>other.order_id===q.order_id&&other.revision>q.revision))
    .filter(q=>`${q.vehicle_snapshot.plate} ${q.vehicle_snapshot.model} ${q.customer_snapshot.name} ${folio('PRE',q.folio_number)} ${data.orders.find(o=>o.id===q.order_id)?.service??''}`.toLowerCase().includes(query.toLowerCase()));
  const page=usePagination(latestQuotes,query);
  const mismatched=existing&&(existing.internalJob!==internal||(!internal&&existing.customerId!==customerId));
  return <><PageHeading title="Presupuestos" description="Cliente, vehículo y detalle del trabajo. Sin registrar un ingreso ni un cobro."
    actions={<Button disabled={!can('expenses.write')} onClick={()=>start()}><Plus size={16}/>Nuevo presupuesto</Button>}/>
    <nav className="module-tabs" aria-label="Vista de presupuestos"><button className={view!=='excel'?'active':''} onClick={()=>setView('list')}>Presupuestos</button>
      <button className={view==='excel'?'active':''} onClick={()=>setView('excel')}>Archivo original</button></nav>
    {view==='excel'&&<WorkbookPreview format="budget"/>}
    {view==='list'&&<><div className="quote-list-tools"><div className="search-field"><Search size={16}/><input aria-label="Buscar presupuesto" placeholder="Folio, cliente o vehículo" value={query} onChange={e=>setQuery(e.target.value)}/></div></div>
      <section className="panel"><AdaptiveTable><thead><tr><th>Presupuesto / cliente</th><th>Vehículo y trabajo</th><th>Estado</th><th>Total</th><th/></tr></thead>
        <tbody>{page.items.map(q=>{const quotedJob=data.orders.find(o=>o.id===q.order_id);return <tr key={q.id}>
          <td><button className="text-link folio-link" onClick={()=>show(q)}>{folio('PRE',q.folio_number)}</button><small>{q.customer_snapshot.name||'Mantenimiento interno'}</small></td>
          <td><strong>{q.vehicle_snapshot.brand} {q.vehicle_snapshot.model} {q.vehicle_snapshot.year}</strong><small>{q.vehicle_snapshot.plate||'Placa sin registrar'} · {quotedJob?.service}</small></td>
          <td><Badge tone={q.status==='Aprobado'?'green':q.status==='Rechazado'?'red':'amber'}>{q.status}</Badge></td>
          <td><strong>{quotedJob?.internalJob?(q.snapshot.costComplete===false?'Por completar':money(q.snapshot.cost)):money(q.snapshot.total)}</strong>{quotedJob?.internalJob&&<small>Costo interno previsto</small>}</td>
          <td><Button variant="outline" size="sm" onClick={()=>show(q)}>Ver detalle</Button></td></tr>;})}</tbody></AdaptiveTable>
        {loading?<p role="status" className="module-loading">Cargando presupuestos…</p>:!latestQuotes.length&&<p className="module-empty">Todavía no hay presupuestos. Seleccione «Nuevo presupuesto» para preparar uno.</p>}
        <Pagination {...page}/></section></>}
    {view==='edit'&&<><button className="budget-back" onClick={()=>setView('list')}><ArrowLeft size={14}/>Volver a presupuestos</button>
      <form className="budget-paper" onSubmit={event=>{
        event.preventDefault();
        const payload={orderId:jobId||null,vehicleId,customerId:internal?null:customerId,service,area,internalJob:internal,
          parentId:latest?.id??null,reason:reason.trim()||'Presupuesto inicial',discount:internal?'0':discount,
          lines:lines.map(l=>({...l,unitPrice:internal?'0':l.unitPrice,unitCost:l.unitCost||null}))};
        void execute('workshop.quote',payload,key=>saveWorkshopQuote(payload,key).then(saved=>{
          setQuotes(current=>[saved,...current.filter(q=>q.id!==saved.id)]);show(saved);
        }));
      }}><fieldset disabled={busy} className="contents"><div className="budget-paper-heading"><div><h2>{latest?'Nueva versión del presupuesto':'Nuevo presupuesto'}</h2><p>Importes en USD. Puede dejar los costos internos para después.</p></div><Badge tone="gray">Borrador</Badge></div>
        {!job&&<label className="budget-internal"><input type="checkbox" checked={internalDraft} onChange={e=>{setInternalDraft(e.target.checked);setVehicleId('');}}/> Mantenimiento interno de la flota</label>}
        <div className="form-grid budget-identity">
          {!internal&&<label className="form-field"><span>Cliente *</span><select aria-label="Cliente del presupuesto" required disabled={!!job} value={customerId} onChange={e=>setCustomerId(e.target.value)}>
            <option value="">Seleccionar cliente</option>{data.customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
            {!job&&<button type="button" className="text-link" onClick={()=>open('cliente')}>Agregar cliente</button>}</label>}
          <label className="form-field"><span>Vehículo *</span><select aria-label="Vehículo del presupuesto" required disabled={!!job} value={vehicleId} onChange={e=>setVehicleId(e.target.value)}>
            <option value="">Seleccionar vehículo</option>{data.vehicles.filter(v=>!internal||v.inRentalFleet).map(v=><option key={v.id} value={v.id}>{v.plate||'Sin placa'} · {v.brand} {v.model} {v.year}</option>)}</select>
            {!job&&<button type="button" className="text-link" onClick={()=>open('vehiculo','client')}>Agregar vehículo</button>}</label>
          <label className="form-field"><span>Trabajo a realizar *</span><input aria-label="Trabajo del presupuesto" required disabled={!!job} maxLength={2000} value={service} onChange={e=>setService(e.target.value)} placeholder="Ej. reparación de la parte delantera"/></label>
          <label className="form-field"><span>Área</span><select aria-label="Área del presupuesto" disabled={!!job} value={area} onChange={e=>setArea(e.target.value)}><option>Mecánica</option><option>Pintura</option></select></label>
        </div>
        {mismatched&&<p className="form-error" role="alert">Este vehículo tiene un trabajo abierto para otro cliente. Revise su expediente antes de continuar.</p>}
        {existing&&!job&&!mismatched&&<p className="field-hint">El presupuesto quedará vinculado al trabajo existente: {existing.service}.</p>}
        <div className="budget-line-list" aria-label="Partidas del presupuesto">{lines.map((line,index)=><div className="budget-line" key={index}>
          <label className="form-field budget-line-description"><span>Descripción {index+1} *</span><input aria-label={`Descripción ${index+1}`} required value={line.description} onChange={e=>change(index,'description',e.target.value)} placeholder="Repuesto, material o trabajo"/></label>
          <label className="form-field"><span>Tipo</span><select aria-label={`Tipo ${index+1}`} value={line.kind} onChange={e=>change(index,'kind',e.target.value)}>{['Material','Trabajo','Tercero','Indirecto'].map(kind=><option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select></label>
          <label className="form-field"><span>Cantidad *</span><input aria-label={`Cantidad ${index+1}`} type="number" step="0.0001" min="0.0001" required value={line.quantity} onChange={e=>change(index,'quantity',e.target.value)}/></label>
          <label className="form-field"><span>{internal?'Costo unitario':'Precio unitario *'}</span><input aria-label={`${internal?'Costo unitario':'Precio unitario'} ${index+1}`} type="number" step="0.0001" min="0" required={!internal} value={internal?line.unitCost:line.unitPrice} onChange={e=>change(index,internal?'unitCost':'unitPrice',e.target.value)} placeholder={internal?'Por definir':'0.00'}/></label>
          <div className="budget-line-total"><span>Importe</span><strong>{internal?(totals.costs[index]===null?'Por definir':money(totals.costs[index]!)):money(totals.prices[index])}</strong></div>
          <Button type="button" variant="ghost" size="icon" disabled={lines.length===1} aria-label={`Quitar partida ${index+1}`} onClick={()=>setLines(lines.filter((_,i)=>i!==index))}><Trash2 size={15}/></Button>
          {!internal&&<details className="budget-line-cost"><summary>Costo interno opcional</summary><label className="form-field"><span>Costo unitario (no se muestra al cliente)</span><input aria-label={`Costo unitario ${index+1}`} type="number" min="0" step="0.0001" value={line.unitCost} onChange={e=>change(index,'unitCost',e.target.value)} placeholder="Por definir"/></label></details>}
        </div>)}</div>
        <div className="flex gap-3 mt-4 flex-wrap"><Button type="button" variant="outline" size="sm" onClick={()=>setLines([...lines,emptyLine()])}><Plus size={14}/>Agregar material</Button>
          <Button type="button" variant="outline" size="sm" onClick={()=>setLines([...lines,emptyLine('Trabajo')])}><Plus size={14}/>Agregar mano de obra</Button></div>
        <div className="budget-tally">{!internal&&<><div><span>Subtotal</span><strong>{money(totals.subtotal)}</strong></div><div><label htmlFor="budget-discount">Descuento</label><input id="budget-discount" type="number" min="0" step="0.01" value={discount} onChange={e=>setDiscount(e.target.value)}/></div></>}
          <div className="grand-total"><span>{internal?'Costo previsto':'Total del presupuesto'}</span><strong>{internal?(totals.costComplete?money(totals.cost):'Por completar'):money(totals.total)}</strong></div></div>
        <label className="form-field"><span>Observaciones{latest?' / motivo del cambio *':''}</span><textarea value={reason} onChange={e=>setReason(e.target.value)} required={!!latest} placeholder="Alcance del trabajo, condiciones o motivo de esta versión"/></label>
        <div className="budget-actions"><Button type="button" variant="outline" onClick={()=>setView('list')}>Cancelar</Button><Button type="submit" disabled={busy||!!mismatched||!vehicleId||(!internal&&!customerId)}>{busy?'Guardando…':'Guardar presupuesto'}</Button></div>
      </fieldset></form></>}
    {view==='detail'&&quote&&<><button className="budget-back" onClick={()=>setView('list')}><ArrowLeft size={14}/>Volver a presupuestos</button><section className="budget-paper">
      <div className="budget-paper-heading"><div><span className="document-folio">{folio('PRE',quote.folio_number)}</span><h2>{quote.customer_snapshot.name||'Mantenimiento interno'}</h2><p>{quote.vehicle_snapshot.brand} {quote.vehicle_snapshot.model} {quote.vehicle_snapshot.year} · {quote.vehicle_snapshot.plate||'Placa sin registrar'}</p><p>{job?.service}</p></div>
        <Badge tone={quote.status==='Aprobado'?'green':quote.status==='Rechazado'?'red':'amber'}>{quote.status}</Badge></div>
      <AdaptiveTable><thead><tr><th>Descripción</th><th>Tipo</th><th>Cantidad</th><th>{internal?'Costo unitario':'Precio unitario'}</th><th>Importe</th></tr></thead><tbody>{quote.snapshot.lines.map((l,i)=><tr key={i}><td><strong>{l.description}</strong></td><td>{kindLabel(l.kind)}</td><td>{l.quantity}</td><td>{internal?(l.unitCost===null?'Por definir':money(l.unitCost)):money(l.unitPrice)}</td><td><strong>{internal?(l.cost===null?'Por definir':money(l.cost)):money(l.price)}</strong></td></tr>)}</tbody></AdaptiveTable>
      <div className="budget-tally">{!internal&&<><div><span>Subtotal</span><strong>{money(quote.snapshot.subtotal)}</strong></div><div><span>Descuento</span><strong>{money(quote.snapshot.discount)}</strong></div></>}<div className="grand-total"><span>{internal?'Costo previsto':'Total'}</span><strong>{internal?(quote.snapshot.costComplete===false?'Por completar':money(quote.snapshot.cost)):money(quote.snapshot.total)}</strong></div></div>
      {quote.source_totals&&<aside className="source-reconciliation"><h3>Resumen anotado en el original</h3><dl><div><dt>Inicial + adicionales</dt><dd>{money(quote.source_totals.initial)} + {money(quote.source_totals.additional)}</dd></div><div><dt>Abono anotado</dt><dd>{money(quote.source_totals.advanceNotPosted)}</dd></div><div><dt>Saldo anotado</dt><dd>{money(quote.source_totals.balanceNotPosted)}</dd></div></dl><p>El abono y el saldo se conservan como referencia: no se han registrado como cobro ni deuda.</p></aside>}
      <p className="text-sm muted mt-4">{quote.reason}</p>
      <div className="budget-actions">{can('expenses.write')&&quote.status==='Borrador'&&quote.id===latest?.id&&job?.status!=='Entregado'&&<Button onClick={()=>setApproval(!approval)}>Aprobar presupuesto</Button>}
        <Button variant="outline" disabled={busy||!can('expenses.write')||job?.status==='Entregado'} onClick={()=>start(quote)}>Crear nueva versión</Button>
        {!internal&&<Button variant="outline" disabled={busy} onClick={()=>{void execute('quote.pdf',{id:quote.id,status:quote.status},async()=>{
          const pdf=await import('@/lib/documents/pdf');let stored=await quotePdf(quote);
          if(!stored)stored=await quotePdf(quote,pdf.bytesToBase64(await pdf.createBusinessPdf(pdf.quoteDocumentContent(quote),await pdf.browserFont())));
          if(stored)pdf.downloadPdf(stored.base64,`${folio('PRE',quote.folio_number)}-V${quote.revision}.pdf`);
        });}}><Download size={15}/>Descargar PDF</Button>}
      </div>
      {approval&&<form className="operation-form mt-5" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);const payload={estimateId:quote.id,approverName:String(f.get('name')),evidence:String(f.get('evidence'))};
        void execute('approve',payload,key=>estimateCommand('approve',payload,key)).then(saved=>{if(saved)setApproval(false);});
      }}><label className="form-field"><span>Persona que aprueba</span><input name="name" required/></label><label className="form-field"><span>Confirmación del cliente</span><textarea name="evidence" required placeholder="Acuerdo por escrito, mensaje o autorización"/></label><Button type="submit" disabled={busy}>Confirmar aprobación</Button></form>}
      <details className="mt-6"><summary className="text-sm muted">Versiones y costos internos</summary><div className="operation-form mt-4"><label className="form-field"><span>Versión</span><select aria-label="Versión del presupuesto" value={selected} onChange={e=>{setSelected(e.target.value);setApproval(false);}}>
        {quotes.filter(q=>q.order_id===quote.order_id).sort((a,b)=>b.revision-a.revision).map(q=><option key={q.id} value={q.id}>{folio('PRE',q.folio_number)} · Versión {q.revision} · {q.status}</option>)}</select></label>
        <p className="text-sm">Costo previsto: {quote.snapshot.costComplete===false?'Por completar':money(quote.snapshot.cost)}</p></div></details>
      <div className="budget-related"><Link className="text-link" href={orderHref(quote.order_id)}>Abrir expediente del trabajo →</Link><span>{job?.status==='Presupuesto'?'Recepción física pendiente':job?.status}</span></div>
    </section></>}
    {(error||loadError)&&<p role="alert" className="form-error mt-4">{error||loadError}</p>}
  </>;
}
