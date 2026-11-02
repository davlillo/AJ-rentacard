'use client';
import {useRef} from 'react';
import {Camera,CarFront,LoaderCircle} from 'lucide-react';
import {VehiclePhoto} from '@/components/atoms/vehicle-photo';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {uploadVehicleFile} from '@/lib/supabase/cases';

export function VehicleImage({vehicleId,plate,fileId,size='card',editable=false,onChange}:{
  vehicleId:string;plate:string;fileId?:string;size?:'card'|'thumbnail'|'detail';editable?:boolean;onChange?:()=>Promise<void>;
}){
  const {can,refresh}=useBusiness();const input=useRef<HTMLInputElement>(null);
  const {busy,error,execute}=useCaseAction(onChange??refresh);
  return <div className={`vehicle-media vehicle-media-${size}`}>
    {fileId?<VehiclePhoto fileId={fileId} plate={plate} variant={size}/>:
      <div className="vehicle-media-empty"><CarFront size={size==='thumbnail'?22:38} strokeWidth={1.25}/>{size!=='thumbnail'&&<span>Foto del vehículo</span>}</div>}
    {editable&&can('orders.write')&&<><input ref={input} type="file" className="sr-only" accept="image/jpeg,image/png,image/webp"
      aria-label={`Archivo de fotografía de ${plate||'este vehículo'}`} disabled={busy} onChange={event=>{
        const file=event.target.files?.[0];if(!file)return;
        const payload={vehicleId,orderId:null,reservationId:null,purpose:'Vehículo',financial:false};
        void execute('vehicle.photo',{...payload,name:file.name,size:file.size,lastModified:file.lastModified},key=>uploadVehicleFile(file,payload,key))
          .then(saved=>{if(saved&&input.current)input.current.value='';});
      }}/><button type="button" className="vehicle-photo-action" disabled={busy} onClick={()=>input.current?.click()}
        aria-label={`${fileId?'Cambiar':'Subir'} foto de ${plate||'este vehículo'}`}>
        {busy?<LoaderCircle size={15} className="animate-spin"/>:<Camera size={15}/>}<span>{busy?'Subiendo…':fileId?'Cambiar foto':'Subir foto'}</span>
      </button></>}
    {error&&<p className="vehicle-photo-error" role="alert">{error}</p>}
  </div>;
}
