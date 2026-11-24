'use client';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {Button} from '@/components/ui/button';
import {VehiclePhoto} from '@/components/atoms/vehicle-photo';
import {loadCase,findOrderVehicle,readVehicleFile,uploadVehicleFile,type CaseFile} from '@/lib/supabase/cases';
import {RegistryDetails} from '@/components/organisms/registry-details';
import {rentalDateTime} from '@/controladores/rental-workflow';
import {VehicleReviewField,VehicleReviewNotes} from '@/components/organisms/vehicle-review';
import {VehicleDossier} from './vehicle-dossier';
import {sanitizedDossierFile} from '@/controladores/vehicle-dossier';
import {receptionPayload} from '@/controladores/workshop-reception';
import {WorkshopCaseScreen} from './workshop-case-screen';

export function VehicleCaseScreen({scope='vehicle'}:{scope?:'vehicle'|'order'}){
  const id=useSearchParams().get('id')??'';
  return <CaseContent key={`${scope}:${id}`} scope={scope} id={id}/>;
}
function CaseContent({scope,id}:{scope:'vehicle'|'order';id:string}){
  const {data,can,source,refresh,modal}=useBusiness();
  const [file,setFile]=useState<CaseFile|null>(null);const [error,setError]=useState('');
  const readRevision=useRef(0);
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
  if(scope==='vehicle')return <VehicleDossier file={sanitizedDossierFile(file,can('expenses.read'))}
    onChange={onChange} filesSlot={<CaseFiles file={sanitizedDossierFile(file,can('expenses.read'))} onChange={onChange}/>}
    administrationSlot={can('vehicles.write')?<><RegistryDetails vehicle={file.vehicle} onChange={onChange}/>
      <FleetData file={sanitizedDossierFile(file,can('expenses.read'))} onChange={onChange}/></>:null}/>;
  const job=file.orders.find(order=>order.id===id);
  if(!job)return <p role="alert" className="form-error">El ingreso no está disponible en este expediente.</p>;
  return <WorkshopCaseScreen file={sanitizedDossierFile(file,can('expenses.read'))} job={job} onChange={onChange}
    receptionSlot={<CaseReception file={file} orderId={job.id} onChange={onChange}/>}
    filesSlot={<CaseFiles file={sanitizedDossierFile(file,can('expenses.read'))} orderId={job.id} onChange={onChange}/>}
    error={error}/>;
}

function CaseReception({file,orderId,onChange}:{file:CaseFile;orderId:string;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const [formError,setFormError]=useState('');
  const inspection=file.inspections.find(i=>i.order_id===orderId);
  const knownKm=Number.isFinite(file.vehicle.km)?Math.max(0,Math.trunc(file.vehicle.km)):0;
  return <section className="panel p-5"><h2 className="font-semibold">Inspección de ingreso</h2>
    {inspection?<div className="mt-4"><VehicleReviewNotes {...inspection}/></div>:
      can('orders.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
        try{
          const payload=receptionPayload(orderId,{km:String(f.get('km')),fuel:String(f.get('fuel')),
            accessories:String(f.get('accessories')),review:String(f.get('review'))},knownKm);
          setFormError('');
          void execute('intake',payload);
        }catch(cause){setFormError((cause as Error).message);}
      }}>
        <div className="form-grid">
          <label className="form-field"><span>Kilometraje (km)</span><input name="km" type="number" required min={knownKm} step="1" defaultValue={knownKm}
            aria-label="Kilometraje de ingreso (km)"/></label>
          <label className="form-field"><span>Combustible (%)</span><input name="fuel" type="number" required min="0" max="100" step="0.01"
            aria-label="Combustible de ingreso (%)" placeholder="Por ejemplo, 75"/></label>
        </div>
        <label className="form-field"><span>Accesorios y herramientas (opcional)</span><input name="accessories" maxLength={2000}
          aria-label="Accesorios de ingreso" placeholder="Llanta de repuesto,aires, documentos, herramientas"/></label>
        <VehicleReviewField/>
        <p className="inline-note">La inspección queda congelada. Las fotos de ingreso se cargan en Fotos y documentos.</p>
        <Button type="submit" disabled={busy}>Guardar inspección del ingreso</Button>
      </form>}{(error||formError)&&<p role="alert" className="form-error">{error||formError}</p>}
  </section>;
}

export function CaseFiles({file,orderId,reservationId,onChange,submitVariant}:{file:CaseFile;orderId?:string;reservationId?:string;onChange:()=>Promise<void>;submitVariant?:'default'|'outline'}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  // One primary action per screen. The rental closing stage already owns one
  // (Guardar versión de contrato), so the shared upload submit is secondary there.
  const uploadVariant=submitVariant??(reservationId?'outline':'default');
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
      <Button type="submit" variant={uploadVariant} disabled={busy}>Guardar archivo en este expediente</Button></form>}
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
