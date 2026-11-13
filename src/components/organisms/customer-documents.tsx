'use client';
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useCaseAction} from '@/hooks/use-case-action';
import {loadCustomerDocuments,uploadCustomerDocument,readCustomerDocument,type CustomerDocument} from '@/lib/supabase/customer-documents';
import {rentalDateTime} from '@/controladores/rental-workflow';

export function CustomerDocuments({customerId}:{customerId:string}){
  const fieldId=useId();
  const [files,setFiles]=useState<CustomerDocument[]>([]);const [loadError,setLoadError]=useState('');
  const [preview,setPreview]=useState<{url:string;kind:string}>();const url=useRef<string|undefined>(undefined);const active=useRef(true);
  const reload=useCallback(async()=>{setFiles(await loadCustomerDocuments(customerId));setLoadError('');},[customerId]);
  const {busy,error,execute}=useCaseAction(reload);
  useEffect(()=>{let active=true;void loadCustomerDocuments(customerId).then(files=>{if(active)setFiles(files);})
    .catch(error=>{if(active)setLoadError(error.message);});return()=>{active=false;};},[customerId]);
  useEffect(()=>{active.current=true;return()=>{active.current=false;if(url.current)URL.revokeObjectURL(url.current);};},[]);
  function hide(){if(url.current)URL.revokeObjectURL(url.current);url.current=undefined;setPreview(undefined);}
  return <section className="customer-documents mt-6" aria-label="Documentos privados del cliente"><h3 className="font-semibold">DUI y licencia</h3>
    <p className="field-hint mt-2">Fotos privadas, disponibles solo para el personal autorizado que administra clientes. No aparecen en presupuestos ni en la galería de vehículos.</p>
    {(['DUI','Licencia'] as const).map(kind=>{const latest=files.find(file=>file.kind===kind);return <article key={kind} className="inline-note mt-4">
      <h4 className="font-semibold">{kind==='DUI'?'Documento de identidad (DUI)':'Licencia de conducir'}</h4>
      {latest?<><p className="mt-2">Última foto: {rentalDateTime(latest.created_at)}</p><Button type="button" variant="outline" className="mt-3" disabled={busy} onClick={()=>{
        void execute('customer.document.view',{id:latest.id},async()=>{const image=await readCustomerDocument(latest.id);if(!active.current)return;hide();
          url.current=URL.createObjectURL(image);setPreview({url:url.current,kind});});
      }}>Ver foto de {kind}</Button></>:<p className="mt-2">Sin foto registrada.</p>}
      <form className="operation-form mt-4" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const photo=new FormData(form).get('photo');
        if(!(photo instanceof File)||!photo.size)return;
        void execute('customer.document.upload',{customerId,kind,name:photo.name,size:photo.size,lastModified:photo.lastModified},
          key=>uploadCustomerDocument(photo,customerId,kind,key)).then(saved=>{if(saved){form.reset();hide();}});
      }}><fieldset disabled={busy} className="contents"><label className="form-field"><span id={fieldId+'-'+kind}>{latest?'Agregar otra foto':'Foto'} de {kind}</span>
        <input name="photo" type="file" required accept="image/jpeg,image/png,image/webp" aria-labelledby={fieldId+'-'+kind}/>
        <small className="field-hint">Hasta 12 MB; se optimiza en este navegador. Las fotos anteriores se conservan.</small></label>
        <Button type="submit" variant="outline">Guardar foto de {kind}</Button></fieldset></form>
    </article>;})}
    {preview&&<figure className="mt-4"><figcaption className="font-semibold mb-3">Foto de {preview.kind}</figcaption>
      <img src={preview.url} alt={`Documento privado: ${preview.kind}`} className="customer-document-preview"/>
      <Button type="button" variant="outline" className="mt-3" onClick={hide}>Ocultar foto</Button></figure>}
    {files.length>0&&<details className="mt-4"><summary className="text-link">Historial de fotos ({files.length})</summary>{files.map(file=><p className="mt-3" key={file.id}>
      <button type="button" className="text-link" disabled={busy} onClick={()=>{void execute('customer.document.view',{id:file.id},async()=>{
        const image=await readCustomerDocument(file.id);if(!active.current)return;hide();url.current=URL.createObjectURL(image);setPreview({url:url.current,kind:file.kind});
      });}}>{file.kind} · {rentalDateTime(file.created_at)}</button></p>)}</details>}
    {(error||loadError)&&<p className="form-error mt-3" role="alert">{error||loadError}</p>}
  </section>;
}
