'use client';
import {useState} from 'react';
import {Download,FileImage,LoaderCircle} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {rentalDocumentFileName,type RentalDocument} from '@/lib/documents/rental-document';
import styles from './rental-document-export.module.css';

// Self-contained control: it receives the whitelisted projection and never reads business data by itself.
export interface RentalDocumentExportProps{
  document:RentalDocument;
}

export function RentalDocumentExport({document}:RentalDocumentExportProps){
  const [busy,setBusy]=useState<'pdf'|'png'|null>(null);
  const [error,setError]=useState('');
  const name=rentalDocumentFileName(document);

  async function generate(kind:'pdf'|'png'){
    setBusy(kind);setError('');
    try{
      if(kind==='pdf'){
        const [layout,helpers]=await Promise.all([import('@/lib/documents/rental-layout'),import('@/lib/documents/pdf')]);
        const bytes=await layout.renderRentalPdf(document,await layout.rentalFontBytes());
        helpers.downloadPdf(helpers.bytesToBase64(bytes),`${name}.pdf`);
      }else{
        const image=await import('@/lib/documents/rental-image');
        await image.downloadRentalImages(document,name);
      }
    }catch(problem){
      setError(problem instanceof Error?problem.message:'No se pudo generar el detalle del alquiler.');
    }finally{
      setBusy(null);
    }
  }

  return <section className={styles.panel} aria-label="Exportar detalle del alquiler">
    <div className={styles.heading}>
      <strong>Detalle del alquiler</strong>
      <span className={styles.hint}>Documento informativo generado en este dispositivo. No es un comprobante fiscal.</span>
    </div>
    <div className={styles.actions}>
      <Button type="button" variant="outline" size="sm" disabled={busy!==null} aria-busy={busy==='pdf'}
        onClick={()=>void generate('pdf')}>
        {busy==='pdf'?<LoaderCircle className={styles.spinner} size={15} aria-hidden="true"/>:<Download size={15} aria-hidden="true"/>}
        {busy==='pdf'?'Generando PDF…':'Descargar detalle (PDF)'}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={busy!==null} aria-busy={busy==='png'}
        onClick={()=>void generate('png')}>
        {busy==='png'?<LoaderCircle className={styles.spinner} size={15} aria-hidden="true"/>:<FileImage size={15} aria-hidden="true"/>}
        {busy==='png'?'Generando PNG…':'Descargar imagen (PNG)'}
      </Button>
    </div>
    {error&&<p className={styles.error} role="alert">{error}</p>}
  </section>;
}

export default RentalDocumentExport;
