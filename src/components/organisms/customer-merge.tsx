'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useBusiness} from '@/hooks/use-business';
import {Button} from '@/components/ui/button';
import {customerHref} from '@/controladores/customer-profile';
import type {Customer} from '@/types';

export function CustomerMerge({customer}:{customer:Customer}){
  const {data,command,toast}=useBusiness();
  const router=useRouter();
  const [targetId,setTargetId]=useState('');
  const [reason,setReason]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const attempt=useRef<{body:string;key:string}|null>(null);
  const sending=useRef(false);
  const target=data.customers.find(other=>other.id===targetId);
  return <details><summary className="text-link">Opciones avanzadas: fusionar una ficha duplicada</summary>
    <form className="operation-form mt-4" onSubmit={async event=>{
      event.preventDefault();
      if(!target||!confirmed||sending.current)return;
      const payload={sourceId:customer.id,targetId:target.id,sourceVersion:customer.version,
        targetVersion:target.version,reason};
      const body=JSON.stringify(payload);
      if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
      sending.current=true;setBusy(true);setError('');
      try{
        await command('merge_customer',payload,attempt.current.key);
        toast('Fusión guardada. Se conservaron las relaciones y las fichas originales.');
        router.replace(customerHref(target.id,'Datos y documentos'));
      }catch(error){setError((error as Error).message);}
      finally{sending.current=false;setBusy(false);}
    }}>
      <h3 className="font-semibold">Fusionar esta ficha</h3>
      <label className="form-field"><span>Ficha que se conservará</span>
        <select required disabled={busy} value={targetId} onChange={event=>{setTargetId(event.target.value);setConfirmed(false);}}>
          <option value="">Seleccionar cliente</option>{data.customers.filter(other=>other.id!==customer.id)
            .map(other=><option key={other.id} value={other.id}>{other.name} · {other.document}</option>)}
        </select></label>
      {target&&<p className="inline-note">{customer.name} se archivará en {target.name}. Se trasladarán sus órdenes
        y vehículos; se conservarán sus datos originales como referencias de búsqueda. No se sumarán ni borrarán movimientos.</p>}
      <label className="form-field"><span>Motivo de la fusión</span>
        <textarea required disabled={busy} value={reason} onChange={event=>setReason(event.target.value)}/></label>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>
        Confirmo que son la misma persona o empresa.</label>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <Button type="submit" disabled={busy||!target||!confirmed}>{busy?'Fusionando…':'Confirmar fusión'}</Button>
    </form>
  </details>;
}
