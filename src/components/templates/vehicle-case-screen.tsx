'use client';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {VehiclePhoto} from '@/components/atoms/vehicle-photo';
import {WorkshopCosts} from '@/components/organisms/workshop-costs';
import {WorkshopDeliveryReview} from '@/components/organisms/workshop-delivery';
import {TaskBoard} from '@/components/organisms/task-board';
import {CaseQuotes} from '@/components/organisms/case-quotes';
import {CaseCostAllocations} from '@/components/organisms/case-cost-allocations';
import {CasePayments} from '@/components/organisms/case-payments';
import {VehicleImage} from '@/components/organisms/vehicle-image';
import {loadCase,findOrderVehicle,orderHref,vehicleHref,readVehicleFile,uploadVehicleFile,type CaseFile} from '@/lib/supabase/cases';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {RegistryDetails} from '@/components/organisms/registry-details';
import {operationMoney} from '@/controladores/operation-money';
import {RefreshCw} from 'lucide-react';
import {diaryHref} from '@/controladores/linked-money';
import {VehicleRentals} from '@/components/organisms/vehicle-rentals';
import {rentalDateTime} from '@/controladores/rental-workflow';
import {VehicleReviewField,VehicleReviewNotes} from '@/components/organisms/vehicle-review';

export function VehicleCaseScreen({scope='vehicle'}:{scope?:'vehicle'|'order'}){
  const id=useSearchParams().get('id')??'';
  return <CaseContent key={`${scope}:${id}`} scope={scope} id={id}/>;
}
function CaseContent({scope,id}:{scope:'vehicle'|'order';id:string}){
  const {data,can,source,refresh,modal,open,toast}=useBusiness();
  const [file,setFile]=useState<CaseFile|null>(null);const [error,setError]=useState('');const [tab,setTab]=useState('Resumen');
  const [refreshing,setRefreshing]=useState(false);
  const readRevision=useRef(0);
  const requestedSection=useSearchParams().get('seccion');
  useEffect(()=>{if(requestedSection&&['Resumen','Ingresos','Alquileres','Recepción','Presupuestos','Costos','Cargos y abonos','Fotos y documentos','Tareas','Salida','Datos de flota'].includes(requestedSection))setTab(requestedSection);},[requestedSection]);
  const order=scope==='order'?data.orders.find(order=>order.id===id):undefined;
  const [resolvedVehicleId,setResolvedVehicleId]=useState<string>();
  const vehicleId=scope==='vehicle'?id:order?.vehicleId??resolvedVehicleId;
  const orderId=scope==='order'?id:undefined;
  useEffect(()=>{let active=true;
    if(scope==='order'&&id&&!order)void findOrderVehicle(id).then(vehicleId=>{if(active)setResolvedVehicleId(vehicleId);})
      .catch(error=>{if(active)setError(error.message);});return()=>{active=false;};
  },[scope,id,order?.vehicleId]);
  const reload=useCallback(async()=>{
    if(!vehicleId)return;
    const revision=++readRevision.current;
    try{const loaded=await loadCase(vehicleId,orderId??undefined);
      if(revision===readRevision.current){setFile(loaded);setError('');}
    }catch(error){if(revision===readRevision.current)throw error;}
  },[vehicleId,orderId]);
  const onChange=useCallback(async()=>{await Promise.all([reload(),refresh()]);},[reload,refresh]);
  useEffect(()=>{let active=true;
    // The keyed case resets on navigation; refresh in place to preserve form drafts.
    if(vehicleId&&source==='supabase')void reload().catch(error=>{if(active)setError(error.message);});
    return()=>{active=false;readRevision.current++;};
  },[vehicleId,source,reload,modal.kind,data]);
  if(source!=='supabase')return <p className="inline-note">El expediente completo requiere una sesión operativa; no utiliza datos ficticios.</p>;
  if(id==='')return <p role="alert" className="form-error">Falta el identificador del expediente. <Link href="/vehiculos">Volver a flota</Link></p>;
  if(error&&!file)return <section className="panel p-5"><p role="alert" className="form-error">{error}</p>
    <Button variant="outline" onClick={()=>{void reload().catch(error=>setError(error.message));}}>Reintentar consulta</Button></section>;
  if(!file)return <p role="status">{scope==='order'&&id&&!order?'Buscando ingreso en el registro autorizado…':'Cargando expediente…'}</p>;
  const car=file.vehicle;const job=scope==='order'?file.orders[0]:undefined;
  const tabs=job?['Resumen','Recepción','Presupuestos','Costos','Cargos y abonos','Fotos y documentos','Tareas','Salida']:
    ['Resumen','Ingresos','Alquileres','Costos','Cargos y abonos','Fotos y documentos','Datos de flota'];
  const financial=['Presupuestos','Costos','Cargos y abonos'];
  const costs=(file.costs??[]).reduce((sum,c)=>sum+Number(c.amount),0);
  const charges=(file.documents??[]).reduce((sum,d)=>sum+Number(d.scope_amount),0);
  const balance=(file.documents??[]).reduce((sum,d)=>sum+Number(d.scope_balance),0);
  const amounts=operationMoney(file,job?.id);
  const internalQuote=!!amounts.quote&&file.orders.some(o=>o.id===amounts.quote?.order_id&&o.internal_job);
  const cover=file.files.filter(f=>f.mime.startsWith('image/')&&!f.financial).sort((a,b)=>
    Number(b.purpose==='Vehículo')-Number(a.purpose==='Vehículo')||b.created_at.localeCompare(a.created_at))[0]?.id??data.vehicles.find(v=>v.id===car.id)?.primaryPhotoId;
  return <>
    <nav aria-label="Ubicación del expediente" className="mb-5"><Link href="/vehiculos">Vehículos</Link> / <Link href={vehicleHref(car.id)}>{car.plate||`${car.brand} ${car.model}`}</Link>
      {job&&<> / {folio('OT',job.id)}</>}</nav>
    <PageHeading eyebrow={job?'PLIEGO POR INGRESO / HISTORIA INDEPENDIENTE':'EXPEDIENTE PERMANENTE DEL VEHÍCULO'}
      title={job?`${folio('OT',job.id)} · ${car.plate||car.brand+' '+car.model}`:`${car.plate?car.plate+' · ':''}${car.brand} ${car.model}`}
      description={job?`${job.service} · ${job.status}`:`${car.year}${car.color?' · '+car.color:''} · ${car.in_rental_fleet?'Flota de alquiler':'Vehículo de taller'}`}
      actions={<Button variant="outline" disabled={refreshing} onClick={()=>{
        setRefreshing(true);void onChange().then(()=>toast('Expediente actualizado.')).catch(error=>setError(error.message)).finally(()=>setRefreshing(false));
      }}><RefreshCw size={15} className={refreshing?'animate-spin':''}/>{refreshing?'Actualizando…':'Actualizar expediente'}</Button>}/>
    <nav className="tabs mb-5 flex-wrap" aria-label="Secciones del expediente">{tabs.filter(t=>!financial.includes(t)||file.financialAccess).map(t=>
      <button key={t} className={tab===t?'active':''} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t}</button>)}</nav>
    {tab==='Resumen'&&!job&&car.in_rental_fleet&&<VehicleRentals file={file} onChange={onChange}/>}
    {tab==='Resumen'&&<section className={`panel p-5 ${!job&&car.in_rental_fleet?'mt-5':''}`}>
      <div className="case-overview"><VehicleImage vehicleId={car.id} plate={car.plate} fileId={cover} size="detail" editable onChange={onChange}/>
        <dl className="detail-list"><div><dt>Vehículo</dt><dd>{car.brand} {car.model} · {car.plate}</dd></div>
          <div><dt>{job?'Estado del trabajo':'Estado del vehículo'}</dt><dd>{job?.status??car.status}</dd></div><div><dt>Titular registral</dt><dd>{car.registered_holder||'Pendiente de registrar'}</dd></div>
          <div><dt>Línea comercial</dt><dd>{car.commercial_line||'Sin clasificar'}</dd></div><div><dt>Kilometraje actual</dt><dd>{car.unverified_fields?.includes('km')?'Por confirmar':`${car.km.toLocaleString()} km`}</dd></div>
          {job&&<><div><dt>Cliente / destino</dt><dd>{job.internal_job?'Mantenimiento interno':data.customers.find(c=>c.id===job.customer_id)?.name??'Sin acceso al cliente'}</dd></div>
            <div><dt>Fecha del ingreso</dt><dd>{job.status==='Presupuesto'?'Aún no se ha recibido':new Date(job.occurred_at).toLocaleString('es-SV',{timeZone:'America/El_Salvador'})}</dd></div>
            <div><dt>Recepción pendiente</dt><dd>{job.pending_fields.join(', ')||'Completa'}</dd></div></>}
         </dl></div>
      {can('vehicles.write')&&<RegistryDetails vehicle={car} onChange={onChange}/>}
       {file.financialAccess&&<details open={job?true:undefined} className="mt-5"><summary className="font-semibold">{job?'Importes de este trabajo':'Totales históricos del vehículo (incluyen operaciones anteriores)'}</summary>
         {!job&&<p className="field-hint mt-3">Estos totales no son el saldo del alquiler actual. Abra cada alquiler o ingreso para consultar y cobrar su operación.</p>}
         {job&&<p className="inline-note mt-5"><strong>{amounts.deliveredWithBalance?'Entregado con saldo por cobrar':amounts.collectionState}</strong>
           {!!amounts.pendingCosts&&` · ${amounts.pendingCosts} costos por revisar en el presupuesto.`}
           {!!amounts.advances&&` · Anticipos disponibles sin aplicar: ${money(amounts.advances)}.`}</p>}
         <dl className="operation-amounts case-money"><div><dt>{internalQuote?'Costo presupuestado':job?'Presupuesto':'Último presupuesto'}</dt><dd>{amounts.quoted===null?'Sin presupuesto':
           internalQuote?(amounts.quote?.snapshot.costComplete===false?'Por completar':money(amounts.quote?.snapshot.cost??0)):money(amounts.quoted)}</dd>
           <small>{internalQuote?'Mantenimiento interno, no es una venta':amounts.quote?.status??'Por preparar'}</small></div>
        <div><dt>Costos del trabajo</dt><dd>{money(costs)}</dd><small>Pagado en caja: {money(amounts.cashOut)}</small></div><div><dt>Cargos emitidos</dt><dd>{money(charges)}</dd></div>
        <div><dt>Abonos aplicados</dt><dd className="amount-paid">{money(amounts.paid)}</dd></div><div className="amount-outstanding"><dt>Por cobrar</dt><dd>{charges?money(balance):'Sin cargo'}</dd></div></dl>
        {job&&<div className="case-money-links">{amounts.quote&&<Link href={`/presupuestos/?id=${amounts.quote.id}`}>Ver presupuesto →</Link>}
          <Link href={`/cobros/?operacion=${encodeURIComponent(job.id)}`}>Ver cargos y abonos →</Link><Link href={`/libro-diario/?operacion=${encodeURIComponent(job.id)}`}>Ver movimientos en diario →</Link></div>}</details>}
      {!job&&can('orders.write')&&<Button className="mt-4" disabled={!['Disponible','Por confirmar'].includes(car.status)} onClick={()=>open('orden',car.id)}>Registrar otro ingreso independiente</Button>}
    </section>}
    {tab==='Recepción'&&job&&<CaseReception file={file} orderId={job.id} onChange={onChange}/>}
    {tab==='Ingresos'&&<section className="panel p-5"><h2 className="text-lg font-semibold">Ingresos y trabajos independientes</h2>
      {file.orders.map(o=><article key={o.id} className="inline-note mt-4"><Link href={orderHref(o.id)}>{folio('OT',o.id)} · {o.service}</Link>
        <p>{o.status} · {o.status==='Presupuesto'?'Sin recepción física':new Date(o.occurred_at).toLocaleDateString('es-SV')} · {o.internal_job?'Interno':'Cliente'}</p></article>)}
      {!file.orders.length&&<p className="mt-4">Este vehículo aún no tiene ingresos de taller.</p>}
    </section>}
    {tab==='Alquileres'&&<><VehicleRentals file={file} onChange={onChange}/><details className="panel p-5 mt-5"><summary className="font-semibold">Bloqueos y compromisos de la agenda</summary>
      {file.commitments.filter(c=>c.active).map(c=><p key={c.id} className="mt-3">
        {c.kind} · Desde {rentalDateTime(c.starts_at)} · Hasta {rentalDateTime(c.ends_at)} · {c.reason}</p>)}
      <Link className="text-link" href="/vehiculos/bloqueos/">Revisar bloqueos →</Link>
    </details></>}
    {tab==='Presupuestos'&&job&&file.financialAccess&&<section className="panel p-5"><CaseQuotes file={file} job={job} onChange={onChange}/></section>}
    {tab==='Costos'&&file.financialAccess&&<section className="panel p-5">
      {job?<><WorkshopCosts orderId={job.id} onChange={onChange}/>
        {can('expenses.write')&&job.status!=='Entregado'&&<CaseCostAllocations file={file} onChange={onChange}/>}</>:
        <><h2 className="font-semibold">Costos de taller por ingreso</h2>{file.orders.map(o=><p className="mt-4" key={o.id}>
          <Link href={orderHref(o.id)}>{o.id} · {o.service}</Link> · {money((file.costs??[]).filter(c=>c.order_id===o.id).reduce((s,c)=>s+Number(c.amount),0))}</p>)}</>}
      <h3 className="font-semibold mt-5">Egresos de caja vinculados (no sumar nuevamente al costo)</h3>
      {(file.expenses??[]).map(e=><p key={e.id} className="inline-note mt-3">{e.date} · {e.id} · {e.concept} · {money(e.scope_amount??e.amount)} · {e.account}
        {e.shared&&<> · Comprobante completo: {money(e.amount)}; aquí se cuenta solo la parte de este expediente.</>}
        <br/><Link className="text-link" href={diaryHref(job?.id,'expense:'+e.id,e.date)}>Ver salida original en Libro diario →</Link></p>)}
      {can('expenses.write')&&<Button className="mt-5" onClick={()=>open('gasto',job?.id??`vehicle:${car.id}`)}>Registrar gasto en este {job?'ingreso':'vehículo'}</Button>}
    </section>}
    {tab==='Cargos y abonos'&&file.financialAccess&&<section className="panel p-5"><CasePayments file={file} job={job} onChange={onChange}/></section>}
    {tab==='Fotos y documentos'&&<CaseFiles file={file} orderId={job?.id} onChange={onChange}/>}
    {tab==='Tareas'&&job&&can('tasks.read')&&<section className="panel p-5"><TaskBoard orderId={job.id}/></section>}
    {tab==='Salida'&&job&&<section className="panel p-5">{car.in_rental_fleet&&<p className="inline-note mb-4">La entrega de taller no confirma limpieza ni disponibilidad para renta. <Link href="/vehiculos/bloqueos">Programe y revise la liberación en Bloqueos.</Link></p>}
      {can('expenses.write')?<WorkshopDeliveryReview orderId={job.id} onChange={onChange}/>:
      <p>La revisión final requiere autorización financiera. Estado actual: {job.status}.</p>}</section>}
    {tab==='Datos de flota'&&<FleetData file={file} onChange={onChange}/>}
    {error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </>;
}

function CaseReception({file,orderId,onChange}:{file:CaseFile;orderId:string;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const inspection=file.inspections.find(i=>i.order_id===orderId);
  return <section className="panel p-5"><h2 className="font-semibold">Inspección de ingreso</h2>
    {inspection?<div className="mt-4"><VehicleReviewNotes {...inspection}/></div>:
      can('orders.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
        void execute('intake',{orderId,km:null,fuel:null,condition:String(f.get('review')).trim(),accessories:''});
      }}><VehicleReviewField/>
        <p className="inline-note">La inspección queda congelada. Las fotos de ingreso se cargan en Fotos y documentos.</p>
        <Button type="submit" disabled={busy}>Guardar inspección del ingreso</Button>
      </form>}{error&&<p role="alert" className="form-error">{error}</p>}
  </section>;
}

export function CaseFiles({file,orderId,reservationId,onChange}:{file:CaseFile;orderId?:string;reservationId?:string;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  return <section className="panel p-5"><h2 className="font-semibold">Fotos y documentos</h2>
    {can('orders.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);const upload=f.get('file');
      if(!(upload instanceof File))return;
      const payload={vehicleId:file.vehicle.id,orderId:orderId??null,reservationId:reservationId??null,purpose:String(f.get('purpose')),financial:f.has('financial')};
      void execute('file',{...payload,name:upload.name,size:upload.size,lastModified:upload.lastModified},key=>uploadVehicleFile(upload,payload,key)).then(saved=>{if(saved)form.reset();});
    }}><label className="form-field"><span>Archivo privado (hasta 2 MB)</span><input name="file" type="file" required accept="image/png,image/jpeg,image/webp,application/pdf"/></label>
      <label className="form-field"><span>Uso del archivo</span><select aria-label="Uso del archivo" name="purpose" defaultValue={orderId?'Ingreso':reservationId?'Salida':'Vehículo'}>
        <option>Vehículo</option>{(orderId||reservationId)&&<><option>Ingreso</option><option>Salida</option></>}<option>Soporte</option></select></label>
      {can('expenses.write')&&<label><input name="financial" type="checkbox"/> Soporte financiero (restringir su consulta)</label>}
      <p className="field-hint">Los PDF se registran como Soporte.</p>
      <Button type="submit" disabled={busy}>Guardar archivo en este expediente</Button></form>}
    <div className="vehicle-grid mt-5">{file.files.map(f=><article className="panel p-4" key={f.id}>
      {f.mime.startsWith('image/')&&<VehiclePhoto fileId={f.id} plate={file.vehicle.plate}/>}
      <h3 className="font-semibold">{f.name}</h3><p>{f.purpose} · {f.order_id??(f.reservation_id?'Alquiler':'Expediente permanente')} · {rentalDateTime(f.created_at)}</p>
      <Button variant="outline" className="mt-3" disabled={busy} onClick={()=>{void execute('file.download',{id:f.id},async()=>{
        const content=await readVehicleFile(f.id);const bytes=Uint8Array.from(atob(content.base64.replace(/\s/g,'')),c=>c.charCodeAt(0));
        const url=URL.createObjectURL(new Blob([bytes],{type:content.mime}));const link=document.createElement('a');
        link.href=url;link.download=content.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      });}}>Descargar archivo</Button>
    </article>)}</div>{!file.files.length&&<p className="mt-4">No hay fotos ni soportes registrados.</p>}
    {error&&<p role="alert" className="form-error">{error}</p>}
  </section>;
}

function FleetData({file,onChange}:{file:CaseFile;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);const car=file.vehicle;
  return <section className="panel p-5"><h2 className="font-semibold">Administración de flota</h2>
    <p className="inline-note mt-3">Incluir en flota no cambia la propiedad. Los vehículos administrados a nombre de terceros requieren decisión explícita.</p>
    {can('vehicles.write')&&<form key={car.version} className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
      void execute('fleet',{vehicleId:car.id,expectedVersion:car.version,included:f.has('included'),
        registeredHolder:String(f.get('registeredHolder')),commercialLine:String(f.get('commercialLine')),reason:String(f.get('reason'))});
    }}><label><input type="checkbox" name="included" defaultChecked={car.in_rental_fleet}/> Incluido en flota de alquiler</label>
      <label className="form-field"><span>Titular registral</span><input name="registeredHolder" defaultValue={car.registered_holder}/></label>
      <label className="form-field"><span>Línea comercial</span><input name="commercialLine" defaultValue={car.commercial_line}/></label>
      <label className="form-field"><span>Motivo del cambio de flota</span><textarea name="reason" required/></label>
      <Button type="submit" disabled={busy}>Guardar decisión de flota</Button></form>}
    {error&&<p role="alert" className="form-error">{error}</p>}
  </section>;
}
