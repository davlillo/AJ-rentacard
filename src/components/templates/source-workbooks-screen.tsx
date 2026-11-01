'use client';
import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {parseSourceWorkbook,type OriginalSheet} from '@/controladores/source-workbooks';
import {listSourceBooks,loadSourceBook,stageSourceBook,reviewSourceItem,sourceDuplicateCandidates,downloadSourceBook,
  workbookFormats,type SourceBook,type SourceBundle,type SourceItem} from '@/lib/supabase/source-workbooks';
import {readRows} from '@/lib/supabase/business';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {orderHref,vehicleHref,rentalHref} from '@/lib/supabase/cases';

export function SourceWorkbooksScreen(){
  const {can,refresh}=useBusiness();const [books,setBooks]=useState<SourceBook[]>([]);const [selected,setSelected]=useState('');
  const [bundle,setBundle]=useState<SourceBundle|null>(null);const [mode,setMode]=useState('Organizado');
  const [category,setCategory]=useState('Todas');const [status,setStatus]=useState('Pendiente');const [query,setQuery]=useState('');
  const [sheet,setSheet]=useState('');const [page,setPage]=useState(0);const [itemId,setItemId]=useState('');const [loadError,setLoadError]=useState('');
  const reload=useCallback(async()=>{
    setBooks(await listSourceBooks());if(selected)setBundle(await loadSourceBook(selected));await refresh();
  },[selected,refresh]);
  const {busy,error,execute}=useCaseAction(reload);
  useEffect(()=>{void listSourceBooks().then(books=>{setBooks(books);const format=new URLSearchParams(window.location.search).get('formato');
    if(format)setSelected(books.find(book=>book.format===format)?.id??'');}).catch(error=>setLoadError(error.message));},[]);
  useEffect(()=>{let active=true;setBundle(null);setItemId('');setPage(0);setCategory('Todas');
    if(selected)void loadSourceBook(selected).then(result=>{if(active){setBundle(result);setSheet(result.book.preview.sheets[0]?.name??'');setLoadError('');}})
      .catch(error=>{if(active)setLoadError(error.message);});return()=>{active=false;};
  },[selected]);
  const filtered=(bundle?.items??[]).filter(i=>(status==='Todos'||i.status===status)&&(category==='Todas'||i.metadata.category===category)&&
    `${i.metadata.title} ${i.source_ref} ${i.metadata.description}`.toLowerCase().includes(query.toLowerCase()));
  const selectedItem=bundle?.items.find(i=>i.id===itemId);
  function showOriginal(item:SourceItem){setMode('Original');setSheet(item.metadata.sheet);setPage(Math.floor((item.metadata.row-1)/50));}
  return <><PageHeading eyebrow="EVIDENCIA ORIGINAL / REVISIÓN EXPLÍCITA" title="Archivos del cliente"
    description="Consulte los cuatro formatos como originales y como registros organizados. Guardar un libro no crea gastos, alquileres ni cobros."/>
    {can('expenses.write')&&<form className="panel p-5 operation-form mb-5" onSubmit={event=>{
      event.preventDefault();const form=event.currentTarget;const upload=new FormData(form).get('file');if(!(upload instanceof File))return;
      void execute('source.upload',{name:upload.name,size:upload.size,lastModified:upload.lastModified},async key=>{
        const parsed=parseSourceWorkbook(upload.name,await upload.arrayBuffer());const saved=await stageSourceBook(parsed,key);setSelected(saved.id);
      });
    }}><label className="form-field"><span>Conservar XLSX original (hasta 5 MB)</span><input type="file" name="file" accept=".xlsx" required/></label>
      <Button type="submit" disabled={busy}>Guardar original y preparar revisión, sin publicar movimientos</Button>
    </form>}
    <section className="panel p-5 mb-5"><label className="form-field"><span>Libro conservado</span><select aria-label="Libro conservado" value={selected} onChange={e=>setSelected(e.target.value)}>
      <option value="">Seleccionar archivo privado</option>{books.map(book=><option key={book.id} value={book.id}>{workbookFormats[book.format]} · {book.file_name}</option>)}</select></label>
      <p className="inline-note mt-4">No se inventan propietarios, fechas ni saldos. Notas, subtotales y ambigüedades permanecen visibles para revisión.
        Los archivos se consultan con permiso financiero; no se publican en una carpeta web.</p>
    </section>
    {bundle&&<>
      <nav className="tabs mb-5" aria-label="Vista del libro">{['Organizado','Original'].map(value=><button key={value} className={mode===value?'active':''}
        onClick={()=>{setMode(value);setPage(0);}}>{value}</button>)}</nav>
      <details className="field-hint mb-4"><summary>Información del archivo</summary><p style={{overflowWrap:'anywhere'}}>{bundle.book.file_name} · SHA-256 {bundle.book.file_hash} · {bundle.book.parser_version}</p></details>
      <Button variant="outline" disabled={busy} onClick={()=>{void execute('source.download',{id:selected},()=>downloadSourceBook(selected));}}>Descargar original sin modificaciones</Button>
      {mode==='Original'?<><label className="form-field mt-4"><span>Hoja original</span><select aria-label="Hoja original" value={sheet} onChange={e=>{setSheet(e.target.value);setPage(0);}}>
        {bundle.book.preview.sheets.map(s=><option key={s.name}>{s.name}</option>)}</select></label>
        <OriginalSheetTable sheet={bundle.book.preview.sheets.find(s=>s.name===sheet)!} page={page} onPage={setPage}/></>:
      <><section className="panel p-5 mt-5"><div className="form-grid">
        <label className="form-field"><span>Buscar en el libro organizado</span><input value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
        <label className="form-field"><span>Sección del libro</span><select aria-label="Sección del libro" value={category} onChange={e=>{setCategory(e.target.value);setPage(0);}}>
          <option>Todas</option>{[...new Set(bundle.items.map(i=>i.metadata.category))].map(c=><option key={c}>{c}</option>)}</select></label>
        <label className="form-field"><span>Estado de revisión</span><select aria-label="Estado de revisión" value={status} onChange={e=>{setStatus(e.target.value);setPage(0);}}>
          {['Todos','Pendiente','Excluido','Vinculado','Publicado'].map(s=><option key={s}>{s}</option>)}</select></label>
      </div><p className="mt-3">{bundle.items.filter(i=>i.status==='Pendiente').length} pendientes · {bundle.items.filter(i=>i.status==='Vinculado').length} vinculados ·
        {' '}{bundle.items.filter(i=>i.status==='Publicado').length} publicados · {bundle.items.filter(i=>i.status==='Excluido').length} excluidos</p></section>
      <section className="panel mt-5"><div className="table-scroll"><AdaptiveTable><thead><tr><th>Origen</th><th>Registro organizado</th><th>Importes originales (no contabilizados)</th><th>Revisión</th></tr></thead>
        <tbody>{filtered.slice(page*25,page*25+25).map(item=><tr key={item.id}><td><button onClick={()=>showOriginal(item)}>{item.source_ref} · Ver celdas</button><small>{item.metadata.date??'Fecha por resolver'}</small></td>
          <td><strong>{item.metadata.title}</strong><small>{item.metadata.category}</small>{item.metadata.warnings.map((warning,i)=><small key={i}>{warning}</small>)}</td>
          <td>{item.metadata.amounts.map(amount=><small key={amount.cell}>{amount.cell}: {money(amount.amount)}</small>)}</td>
          <td>{item.status}<small>{item.reason}</small>{item.record_id&&sourceHref(item)&&<Link className="text-link" href={sourceHref(item)!}>Abrir registro vinculado →</Link>}
            <Button variant="outline" onClick={()=>setItemId(item.id)}>Revisar registro</Button></td></tr>)}</tbody></AdaptiveTable></div>
        <Pager page={page} count={filtered.length} size={25} onPage={setPage}/>
      </section>
      {selectedItem&&<ReviewSourceItem key={`${selectedItem.id}:${selectedItem.version}`} item={selectedItem} onChange={reload} onClose={()=>setItemId('')}/>}
      </>}
    </>}
    {(loadError||error)&&<p role="alert" className="form-error mt-4">{loadError||error}</p>}
  </>;
}

function Pager({page,count,size,onPage}:{page:number;count:number;size:number;onPage:(page:number)=>void}){
  return <div className="form-footer p-4"><Button variant="outline" disabled={page===0} onClick={()=>onPage(page-1)}>Anterior</Button>
    <span>Página {page+1} de {Math.max(1,Math.ceil(count/size))} · {count} registros / filas</span>
    <Button variant="outline" disabled={(page+1)*size>=count} onClick={()=>onPage(page+1)}>Siguiente</Button></div>;
}
function OriginalSheetTable({sheet,page,onPage}:{sheet:OriginalSheet;page:number;onPage:(page:number)=>void}){
  const last=Number(sheet.range.match(/(\d+)$/)?.[1]??1);
  return <section className="panel mt-5"><p className="p-4 field-hint">{sheet.name} · {sheet.range} · Valores originales guardados; las fórmulas no se ejecutan.</p>
    <div className="source-cell-rows">{sheet.rows.filter(row=>row.number>page*50&&row.number<=(page+1)*50).map(row=><section key={row.number}>
      <h3>Fila {row.number}</h3><dl>{row.cells.map(cell=><div key={cell.address}><dt>{cell.address}</dt><dd>{cell.display}
        {cell.formula&&<small>Fórmula guardada: {cell.formula}</small>}</dd></div>)}</dl></section>)}</div>
    <Pager page={page} count={last} size={50} onPage={onPage}/>
  </section>;
}

function sourceHref(item:SourceItem):string|undefined{
  if(!item.record_id)return;
  if(item.record_type==='vehicle')return vehicleHref(item.record_id);
  if(item.record_type==='order')return orderHref(item.record_id);
  if(item.record_type==='reservation')return rentalHref(item.record_id);
  if(item.record_type==='quote')return `/presupuestos/?id=${encodeURIComponent(item.record_id)}`;
  if(item.record_type==='expense')return '/libro-diario';
  return '/cobros';
}

function ReviewSourceItem({item,onChange,onClose}:{item:SourceItem;onChange:()=>Promise<void>;onClose:()=>void}){
  const {data,can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);const form=useRef<HTMLFormElement>(null);
  const [action,setAction]=useState('link');const [kind,setKind]=useState(item.metadata.category==='Flota'?'vehicle':item.metadata.category==='Abono por revisar'?'receipt':'expense');
  const [destination,setDestination]=useState('center');const [ownership,setOwnership]=useState('Cliente');
  const [options,setOptions]=useState<{id:string;label:string}[]>([]);const [candidates,setCandidates]=useState<{id:string;concept:string;amount:number;date:string}[]>([]);
  const [candidateError,setCandidateError]=useState('');
  useEffect(()=>{let active=true;
    const local=kind==='vehicle'?data.vehicles.map(v=>({id:v.id,label:`${v.plate} · ${v.brand} ${v.model}`})):
      kind==='order'?data.orders.map(o=>({id:o.id,label:`${o.id} · ${o.service}`})):
      kind==='reservation'?(data.reservationHistory??[]).map(r=>({id:r.id,label:`${data.vehicles.find(v=>v.id===r.vehicleId)?.plate} · ${r.start}`})):
      kind==='expense'?data.movements.filter(m=>m.type==='Egreso').map(m=>({id:m.id,label:`${m.id} · ${m.date} · ${money(m.amount)} · ${m.concept}`})):null;
    if(local){setOptions(local);return;}
    const table=kind==='receipt'?'customer_payments':kind==='quote'?'estimate_versions':'billing_documents';
    void readRows<{id:string;description?:string;reference?:string;order_id?:string;revision?:number}>(table,'*').then(rows=>{
      if(active)setOptions(rows.map(r=>({id:r.id,label:r.description??r.reference??`${r.order_id} V${r.revision}`})));
    }).catch(error=>{if(active)setCandidateError(error.message);});return()=>{active=false;};
  },[kind,data]);
  function proposal(f:FormData):Record<string,unknown>{
    const fields=Object.fromEntries([...f.entries()].filter(([key])=>key.startsWith('p.')).map(([key,value])=>[key.slice(2),String(value)]));
    if(kind==='expense')return{...fields,...(destination==='order'?{operationId:fields.destination}:destination==='reservation'?{reservationId:fields.destination}:
      destination==='vehicle'?{vehicleId:fields.destination}:{costCenterId:fields.destination})};
    if(kind==='vehicle')return{...fields,ownership,ownerCustomerId:ownership==='Cliente'?fields.ownerCustomerId:null,inRentalFleet:f.has('inRentalFleet')};
    return fields;
  }
  const readonly=item.status==='Vinculado'||item.status==='Publicado';
  return <section className="panel p-5 mt-5" aria-label="Revisión del registro de origen"><h2 className="text-lg font-semibold">{item.source_ref} · {item.metadata.title}</h2>
    <p className="inline-note mt-3">{item.metadata.description}</p><p className="mt-3">{item.metadata.warnings.join(' ')}</p>
    {readonly?<p className="mt-4">Este origen ya está vinculado y no se vuelve a publicar. {sourceHref(item)&&<Link className="text-link" href={sourceHref(item)!}>Abrir registro vinculado →</Link>}</p>:
    can('expenses.write')&&<form ref={form} className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);const proposed=proposal(f);
      const payload={itemId:item.id,expectedVersion:item.version,action,recordType:kind,reason:String(f.get('reason')),
        recordId:String(f.get('recordId')??''),proposal:action==='publish'?proposed:null,expectedAmount:String(f.get('expectedAmount')??''),distinctConfirmed:f.has('distinctConfirmed')};
      void execute('source.review',payload,key=>reviewSourceItem(payload,key));
    }}><fieldset disabled={busy} className="contents">
      <label className="form-field"><span>Decisión del origen</span><select aria-label="Decisión del origen" value={action} onChange={e=>{setAction(e.target.value);if(e.target.value==='publish'&&!['expense','receipt','vehicle'].includes(kind))setKind('expense');}}>
        <option value="link">Vincular a un registro existente, sin duplicarlo</option><option value="exclude">Excluir de la migración con motivo</option>
        {item.status==='Excluido'&&<option value="reopen">Reabrir revisión (sin crear movimientos)</option>}
        {item.metadata.category!=='Control'&&item.status==='Pendiente'&&<option value="publish">Crear un hecho nuevo revisado</option>}</select></label>
      {(action==='link'||action==='publish')&&<label className="form-field"><span>Tipo de registro que representa</span><select aria-label="Tipo de registro que representa" value={kind} onChange={e=>{setKind(e.target.value);setCandidates([]);}}>
        {Object.entries({expense:'Gasto',receipt:'Recibo de cliente',vehicle:'Vehículo',...(action==='link'?{order:'Ingreso',reservation:'Alquiler',quote:'Presupuesto',document:'Documento de cobro'}:{})})
          .map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}
      {action==='link'&&<label className="form-field"><span>Registro existente verificado</span><select aria-label="Registro existente verificado" name="recordId" required defaultValue="">
        <option value="">Seleccionar coincidencia real</option>{options.map(o=><option value={o.id} key={o.id}>{o.label}</option>)}</select></label>}
      {action==='publish'&&<>
        {(kind==='expense'||kind==='receipt')&&<>
          <label className="form-field"><span>Fecha verificada</span><input name="p.date" type="date" required defaultValue={item.metadata.date??''}/></label>
          <label className="form-field"><span>Importe verificado USD</span><input name="p.amount" type="number" step="0.01" min="0.01" required defaultValue={item.metadata.amounts.length===1?item.metadata.amounts[0].amount:''}/></label>
          <label className="form-field"><span>Medio verificado</span><select aria-label="Medio verificado" name="p.method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
          <label className="form-field"><span>Cuenta verificada</span><input name="p.account" required/></label>
          <label className="form-field"><span>Importe conciliado con el original USD</span><input name="expectedAmount" type="number" step="0.01" min="0.01" required/></label>
          <Button type="button" variant="outline" onClick={()=>{if(!form.current)return;void sourceDuplicateCandidates(kind,proposal(new FormData(form.current)))
            .then(setCandidates).catch(error=>setCandidateError(error.message));}}>Buscar registros de igual fecha e importe</Button>
          {candidates.map(c=><p className="inline-note" key={c.id}>Posible coincidencia: {c.id} · {c.date} · {money(c.amount)} · {c.concept}</p>)}
          <label><input type="checkbox" name="distinctConfirmed"/> Si hay coincidencias, confirmé que este es OTRO hecho real y lo justifico abajo</label>
        </>}
        {kind==='expense'&&<>
          <label className="form-field"><span>Concepto verificado</span><input name="p.concept" required defaultValue={item.metadata.title}/></label>
          <label className="form-field"><span>Categoría del gasto</span><input name="p.category" required/></label>
          <label className="form-field"><span>Clase de destino verificado</span><select aria-label="Clase de destino verificado" value={destination} onChange={e=>setDestination(e.target.value)}>
            <option value="center">Centro de costo</option><option value="order">Ingreso de taller</option><option value="reservation">Alquiler</option><option value="vehicle">Vehículo</option></select></label>
          <label className="form-field"><span>Destino verificado</span><select aria-label="Destino verificado" name="p.destination" required>
            {destination==='center'?<><option value="administration">Administración</option><option value="workshop">Taller</option><option value="rental">Renta</option></>:
              destination==='order'?data.orders.filter(o=>o.status!=='Entregado').map(o=><option value={o.id} key={o.id}>{o.id} · {o.service}</option>):
              destination==='vehicle'?data.vehicles.map(v=><option value={v.id} key={v.id}>{v.plate}</option>):
              (data.reservationHistory??[]).map(r=><option value={r.id} key={r.id}>{r.id}</option>)}</select></label>
          <label className="form-field"><span>Referencia del soporte verificado</span><input name="p.support" required/></label>
        </>}
        {kind==='receipt'&&<><label className="form-field"><span>Cliente del recibo verificado</span><select aria-label="Cliente del recibo verificado" name="p.customerId" required defaultValue="">
          <option value="">Seleccionar cliente real</option>{data.customers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
          <label className="form-field"><span>Referencia del recibo verificado</span><input name="p.reference" required/></label>
          <p className="inline-note">Crear el recibo no lo aplica a una deuda. Su aplicación se revisa en Cargos y cobros.</p></>}
        {kind==='vehicle'&&<>
          {(['plate','brand','model','year','category','color','daily','km','registeredHolder','commercialLine'] as const).map(field=><label className="form-field" key={field}>
            <span>{{plate:'Placa verificada',brand:'Marca verificada',model:'Modelo verificado',year:'Año verificado',category:'Categoría verificada',color:'Color verificado',daily:'Tarifa diaria verificada USD',km:'Kilometraje verificado',registeredHolder:'Titular registral',commercialLine:'Línea comercial'}[field]}</span>
            <input name={`p.${field}`} required={!['registeredHolder','commercialLine'].includes(field)}
              type={['year','daily','km'].includes(field)?'number':'text'} min={field==='year'?1900:0} step={field==='daily'?'0.01':'1'}
              defaultValue={field==='plate'?String(item.metadata.facts.plate??''):field==='registeredHolder'?String(item.metadata.facts.registeredHolder??''):field==='commercialLine'?String(item.metadata.facts.commercialLine??''):''}/></label>)}
          <label className="form-field"><span>Relación de propiedad verificada</span><select aria-label="Relación de propiedad verificada" value={ownership} onChange={e=>setOwnership(e.target.value)}><option>Cliente</option><option>Propio</option></select></label>
          {ownership==='Cliente'&&<label className="form-field"><span>Propietario identificado en el registro</span><select aria-label="Propietario identificado en el registro" name="p.ownerCustomerId" required defaultValue=""><option value="">Seleccionar cliente real</option>{data.customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          <label><input type="checkbox" name="inRentalFleet"/> Confirmé que forma parte de la flota administrada de alquiler</label>
        </>}
      </>}
      <label className="form-field"><span>Motivo y evidencia de la revisión</span><textarea name="reason" required/></label>
      <Button type="submit">{action==='publish'?'Publicar UN hecho revisado':action==='link'?'Guardar vínculo sin crear movimientos':'Guardar decisión de revisión'}</Button>
    </fieldset></form>}
    <p className="inline-note mt-4">Para presupuestos completos, alquileres y documentos agrupados, primero resuelva las identidades y
      {' '}<Link href="/taller">cree el ingreso/presupuesto</Link> o <Link href="/cobros">el documento desglosado</Link>; después vincule aquí su origen.</p>
    {(error||candidateError)&&<p role="alert" className="form-error mt-4">{error||candidateError}</p>}
    <Button variant="outline" className="mt-4" onClick={onClose}>Cerrar revisión</Button>
  </section>;
}
