'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {Download,FileSpreadsheet,Search} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import type {WorkbookFormat} from '@/controladores/source-workbooks';
import {workbookSections,type SourceSection} from '@/controladores/workbook-facts';
import {listSourceBooks,loadSourceBook,downloadSourceBook,type SourceBook} from '@/lib/supabase/source-workbooks';
import {Pagination,usePagination} from './pagination';
import styles from './workbook-preview.module.css';

export function WorkbookPreview({format}:{format:WorkbookFormat}){
  const {can}=useBusiness();const [book,setBook]=useState<SourceBook>();const [sections,setSections]=useState<SourceSection[]>([]);
  const [section,setSection]=useState('Todas');const [query,setQuery]=useState('');
  const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [downloading,setDownloading]=useState(false);
  const allowed=can('expenses.read');
  useEffect(()=>{let active=true;setLoading(true);setError('');setSection('Todas');setQuery('');
    if(!allowed){setLoading(false);return;}
    void listSourceBooks().then(async books=>{
      const source=books.filter(b=>b.format===format).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
      if(!source){if(active){setBook(undefined);setSections([]);setLoading(false);}return;}
      const bundle=await loadSourceBook(source.id);
      if(active){setBook(source);setSections(workbookSections(format,bundle.book.preview.sheets));setLoading(false);}
    }).catch(error=>{if(active){setError(error.message);setLoading(false);}});return()=>{active=false;};
  },[format,allowed]);
  const records=sections.filter(group=>section==='Todas'||group.title===section).flatMap(group=>group.records.map(record=>({...record,group:group.title})))
    .filter(record=>`${record.title} ${record.detail} ${record.date} ${record.amount}`.toLocaleLowerCase('es-SV').includes(query.toLocaleLowerCase('es-SV')));
  const page=usePagination(records,section+query);
  if(!allowed)return <p className="module-empty">La consulta del archivo requiere permiso financiero.</p>;
  if(loading)return <p className="module-loading" role="status">Cargando datos del archivo…</p>;
  if(error)return <p className="form-error" role="alert">{error}</p>;
  if(!book)return <p className="module-empty">No hay un archivo guardado para esta sección.</p>;
  return <section className={styles.viewer} aria-label="Datos del archivo original">
    <div className={styles.toolbar}><div className={styles.filename}><FileSpreadsheet size={21}/><div><strong>{book.file_name}</strong>
      <span>Datos del original, organizados para consulta</span></div></div>
      <Button variant="outline" size="sm" disabled={downloading} onClick={()=>{
        setDownloading(true);void downloadSourceBook(book.id).catch(error=>setError(error.message)).finally(()=>setDownloading(false));
      }}><Download size={15}/>{downloading?'Descargando…':'Descargar original'}</Button></div>
    <div className={styles.filters}><div className="search-field"><Search size={16}/><input aria-label="Buscar en el archivo" placeholder="Buscar concepto, cliente o placa" value={query} onChange={e=>setQuery(e.target.value)}/></div>
      <label><span className="sr-only">Sección del archivo</span><select aria-label="Sección del archivo" value={section} onChange={e=>setSection(e.target.value)}>
        <option>Todas</option>{[...new Set(sections.map(group=>group.title))].map(title=><option key={title}>{title}</option>)}</select></label></div>
    <div className={styles.records}>{page.items.map((record,index)=><div key={record.reference+index}>
      {(index===0||page.items[index-1].group!==record.group)&&<h3 className={styles.group}>{record.group}</h3>}
      <article className={styles.record} title={record.reference}><div><strong>{record.title}</strong>{record.detail&&<p>{record.detail}</p>}
        {record.date&&<span>{record.date}</span>}</div>{record.amount&&<b>{record.amount}</b>}</article>
    </div>)}{!records.length&&<p className="module-empty">No hay coincidencias en el archivo.</p>}</div>
    <Pagination {...page}/>
    <div className={styles.note}><span>Las anotaciones históricas no se suman a cobros o movimientos sin revisión.</span>
      <Link href={`/archivos/?formato=${format}`}>Revisar vínculos →</Link></div>
  </section>;
}

export function WorkbookWorkspace({format,children}:{format:WorkbookFormat;children:React.ReactNode}){
  const {can}=useBusiness();const [view,setView]=useState('system');
  return <><nav className="module-tabs" aria-label="Vista de la sección">
    <button className={view==='system'?'active':''} aria-pressed={view==='system'} onClick={()=>setView('system')}>Gestión</button>
    {can('expenses.read')&&<button className={view==='excel'?'active':''} aria-pressed={view==='excel'} onClick={()=>setView('excel')}>Archivo original</button>}
  </nav>{view==='excel'?<WorkbookPreview format={format}/>:children}</>;
}
