'use client';
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {FileImage,IdCard,ShieldCheck} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';
import {useCaseAction} from '@/hooks/use-case-action';
import {loadCustomerDocuments,uploadCustomerDocument,readCustomerDocument,type CustomerDocument} from '@/lib/supabase/customer-documents';
import {rentalDateTime} from '@/controladores/rental-workflow';
import styles from './customer-documents.module.css';
import {Disclosure} from '@/components/organisms/disclosure';

const kinds=['DUI','Licencia'] as const;
type DocumentKind=typeof kinds[number];
const kindTitle:(kind:DocumentKind)=>string=kind=>kind==='DUI'?'Documento de identidad (DUI)':'Licencia de conducir';

export function CustomerDocuments({customerId,customerName}:{customerId:string;customerName?:string}){
  const fieldId=useId();
  const [files,setFiles]=useState<CustomerDocument[]>([]);const [loadError,setLoadError]=useState('');
  // The photo lives in a modal: it never stays appended under the list of documents.
  const [preview,setPreview]=useState<{url:string;kind:DocumentKind}|null>(null);
  const [loading,setLoading]=useState<DocumentKind|null>(null);
  const url=useRef<string|undefined>(undefined);const active=useRef(true);
  const trigger=useRef<HTMLButtonElement|null>(null);
  const reload=useCallback(async()=>{setFiles(await loadCustomerDocuments(customerId));setLoadError('');},[customerId]);
  const {busy,error,execute}=useCaseAction(reload);
  useEffect(()=>{let active=true;void loadCustomerDocuments(customerId).then(files=>{if(active)setFiles(files);})
    .catch(error=>{if(active)setLoadError(error.message);});return()=>{active=false;};},[customerId]);
  useEffect(()=>{active.current=true;return()=>{active.current=false;if(url.current)URL.revokeObjectURL(url.current);};},[]);
  function hide(){if(url.current){URL.revokeObjectURL(url.current);url.current=undefined;}setPreview(null);setLoading(null);}
  // The authorized private file is read exactly as before; only the presentation changes.
  function view(file:CustomerDocument,kind:DocumentKind,button:HTMLButtonElement){
    trigger.current=button;
    setLoading(kind);
    void execute('customer.document.view',{id:file.id},async()=>{
      const image=await readCustomerDocument(file.id);
      if(!active.current)return;
      if(url.current)URL.revokeObjectURL(url.current);
      url.current=URL.createObjectURL(image);
      setPreview({url:url.current,kind});
    }).finally(()=>setLoading(null));
  }
  return <section className="customer-documents mt-6" aria-label="Documentos privados del cliente">
    <header className={styles.header}>
      <span className={styles.headerIcon} aria-hidden="true"><ShieldCheck size={18}/></span>
      <div><h3 className="font-semibold">DUI y licencia</h3>
        <p className="field-hint mt-2">Fotos privadas, disponibles solo para el personal autorizado que administra clientes. No aparecen en presupuestos ni en la galería de vehículos.</p></div>
    </header>
    <div className={styles.cards}>
      {kinds.map(kind=>{const latest=files.find(file=>file.kind===kind);return <article key={kind} className={styles.card}>
        <header className={styles.cardHeader}>
          <span className={styles.cardIcon} aria-hidden="true"><IdCard size={18}/></span>
          <div><h4 className="font-semibold">{kindTitle(kind)}</h4>
            <p className={styles.meta}>{latest?`Última foto: ${rentalDateTime(latest.created_at)}`:'Sin foto registrada'}</p></div>
        </header>
        {latest?<Button type="button" variant="outline" disabled={busy} onClick={event=>view(latest,kind,event.currentTarget)}>
          <FileImage size={16} aria-hidden="true"/>Ver foto de {kind}</Button>:
          <p className={styles.empty}>Todavía no hay una foto de {kind}. Cargue la primera para poder verla aquí.</p>}
        <form className="operation-form mt-4" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const photo=new FormData(form).get('photo');
          if(!(photo instanceof File)||!photo.size)return;
          void execute('customer.document.upload',{customerId,kind,name:photo.name,size:photo.size,lastModified:photo.lastModified},
            key=>uploadCustomerDocument(photo,customerId,kind,key)).then(saved=>{if(saved){form.reset();hide();}});
        }}><fieldset disabled={busy} className="contents"><label className="form-field"><span id={fieldId+'-'+kind}>{latest?'Agregar otra foto':'Foto'} de {kind}</span>
          <input name="photo" type="file" required accept="image/jpeg,image/png,image/webp" aria-labelledby={fieldId+'-'+kind}/>
          <small className="field-hint">Hasta 12 MB; se optimiza en este navegador. Las fotos anteriores se conservan.</small></label>
          <Button type="submit" variant="outline">Guardar foto de {kind}</Button></fieldset></form>
      </article>;})}
    </div>
    {files.length>0&&<Disclosure className="mt-4" label={`Historial de fotos (${files.length})`}>{files.map(file=><p className="mt-3" key={file.id}>
      <button type="button" className="text-link" disabled={busy} onClick={event=>view(file,file.kind,event.currentTarget)}>{file.kind} · {rentalDateTime(file.created_at)}</button></p>)}</Disclosure>}
    {(error||loadError)&&<p className="form-error mt-3" role="alert">{error||loadError}</p>}
    <Dialog open={Boolean(preview)||loading!==null} onOpenChange={open=>{if(!open)hide();}}>
      <DialogContent className={styles.viewer} onCloseAutoFocus={event=>{event.preventDefault();trigger.current?.focus();}}>
        <DialogTitle className={styles.viewerTitle}>{preview?`${preview.kind} · ${customerName||'Cliente'}`:
          loading?`Cargando ${loading}…`:'Documento de identidad'}</DialogTitle>
        <DialogDescription className={styles.viewerHint}>Documento privado: solo el personal autorizado que administra clientes puede ver esta foto.</DialogDescription>
        {preview&&<img src={preview.url} alt={`Documento privado: ${preview.kind}`} className={styles.image}/>}
        {!preview&&loading&&<p className={styles.viewerHint}>Preparando la foto de {loading}.</p>}
      </DialogContent>
    </Dialog>
  </section>;
}
