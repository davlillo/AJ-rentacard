'use client';
import {useEffect,useState} from 'react';
import {CarFront} from 'lucide-react';
import {readVehicleFile} from '@/lib/supabase/cases';
import {isShowcase} from '@/lib/showcase';

export function VehiclePhoto({fileId,plate,variant='detail'}:{fileId?:string;plate:string;variant?:'card'|'thumbnail'|'detail'}){
  const [url,setUrl]=useState('');const [error,setError]=useState('');
  useEffect(()=>{let active=true;let objectUrl='';setUrl('');setError('');
    if(fileId)void readVehicleFile(fileId).then(file=>{
      if(!active||!['image/png','image/jpeg','image/webp'].includes(file.mime))return;
      const bytes=Uint8Array.from(atob(file.base64.replace(/\s/g,'')),c=>c.charCodeAt(0));
      objectUrl=URL.createObjectURL(new Blob([bytes],{type:file.mime}));setUrl(objectUrl);
    }).catch(()=>{if(active)setError('No se pudo cargar la foto.');});
    return()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[fileId]);
  const status=error||(fileId?'Cargando imagen…':'Sin fotografía real registrada');
  return url?<img src={url} alt={`${isShowcase?'Ilustración de referencia':'Fotografía'} de ${plate}`} width={480} height={260}
    loading="lazy" className={`vehicle-photo vehicle-photo-${variant}`}/>:
    variant==='thumbnail'?<span className="flex h-full min-w-0 items-center justify-center text-muted-foreground" role="status" aria-label={status}><CarFront size={22}/></span>:
    <p className="p-4 break-words text-muted-foreground" role="status">{status}</p>;
}
