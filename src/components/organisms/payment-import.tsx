'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {parseImportWorkbook,type ImportWorkbook} from '@/controladores/import-workbook';
import {paymentImportCommand,paymentImports,paymentImportOriginal,type PaymentImport} from '@/lib/supabase/payment-imports';
import {money} from '@/controladores/finanzas';
import {AdaptiveTable} from './adaptive-table';

const fields=[['customerId','Cliente UUID','cliente_id'],['documentId','Documento UUID (opcional)','documento_id'],['date','Fecha del pago','fecha'],['amount','Monto del pago','monto'],
  ['method','Medio del pago','medio'],['account','Cuenta del pago','cuenta'],['reference','Referencia del pago','referencia'],['sourceKey','Clave de origen del pago','id_origen']];
export function PaymentImportPanel({onPublished}:{onPublished:()=>Promise<void>}){
  const [book,setBook]=useState<ImportWorkbook|null>(null);const [sheet,setSheet]=useState('');const [batch,setBatch]=useState<PaymentImport|null>(null);
  const [history,setHistory]=useState<PaymentImport[]>([]);const [mapping,setMapping]=useState<Record<string,string>>({});const [source,setSource]=useState('customer-receipts');
  const [decisions,setDecisions]=useState<PaymentImport['decisions']>({});const [total,setTotal]=useState('');const [dirty,setDirty]=useState(true);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function show(batch:PaymentImport){setBatch(batch);setMapping(batch.mapping);setSource(batch.source_system||'customer-receipts');setDecisions(batch.decisions);setTotal('');setDirty(batch.status==='Preparado');setHistory(await paymentImports());}
  useEffect(()=>{void paymentImports().then(setHistory).catch(error=>setError(error.message));},[]);
  async function run(action:()=>Promise<void>){if(sending.current)return;sending.current=true;setBusy(true);setError('');try{await action();}catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}}
  async function submit(command:'stage'|'validate'|'commit',payload:Record<string,unknown>){const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    const result=await paymentImportCommand(command,payload,attempt.current.key);await show(result);attempt.current=null;return result;}
  const columns=book?.sheets.find(s=>s.name===sheet)?.columns??Object.keys(batch?.rows[0]?.cells??{});
  const published=batch?.status==='Publicado';
  return <details className="panel p-5 mb-5"><summary>Importar pagos desde XLSX o CSV</summary>
    <p className="field-hint">Los pagos se conservan como recibos, nunca como gastos. Cliente/documento usan UUID existentes. Cada lote conserva original, hash, hoja y filas; confirmar requiere conciliación.</p>
    <label className="form-field mt-4"><span>Archivo de pagos</span><input type="file" accept=".xlsx,.csv" disabled={busy} onChange={event=>{
      const file=event.target.files?.[0];if(file)void run(async()=>{const parsed=parseImportWorkbook(file.name,await file.arrayBuffer());setBook(parsed);setSheet(parsed.sheets[0].name);setBatch(null);setDirty(true);});
    }}/></label>
    {book&&<><label className="form-field"><span>Hoja de pagos</span><select aria-label="Hoja de pagos" value={sheet} onChange={event=>{setSheet(event.target.value);setBatch(null);}}>{book.sheets.map(s=><option key={s.name}>{s.name}</option>)}</select></label>
      <Button className="mt-3" disabled={busy} onClick={()=>{void run(async()=>{const saved=await submit('stage',{fileName:book.fileName,base64:book.base64,sheet,rows:book.sheets.find(s=>s.name===sheet)!.rows});
        if(!Object.keys(saved.mapping).length)setMapping(Object.fromEntries(fields.map(([field,,example])=>[field,columns.find(column=>column===example||column===field)??''])));
      });}}>Guardar original y preparar lote de pagos</Button></>}
    {batch&&<section className="mt-4"><strong>{batch.file_name} · {batch.status}</strong><small>SHA-256 {batch.file_hash} · {batch.id}</small>
      <Button variant="outline" className="mt-3" disabled={busy} onClick={()=>{void run(async()=>{const base64=await paymentImportOriginal(batch.id);const bytes=Uint8Array.from(atob(base64.replaceAll('\n','')),c=>c.charCodeAt(0));
        const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([bytes]));link.download=batch.file_name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
      });}}>Descargar original de pagos</Button>
      {!published&&<><label className="form-field mt-4"><span>Sistema de origen de pagos</span><input value={source} onChange={event=>{setSource(event.target.value);setDirty(true);}}/></label>
        <div className="form-grid">{fields.map(([field,label])=><label className="form-field" key={field}><span>{label}</span><select aria-label={`Columna de ${label}`} value={mapping[field]??''} onChange={event=>{setMapping({...mapping,[field]:event.target.value});setDirty(true);}}>
          <option value="">Sin columna</option>{columns.map(column=><option key={column}>{column}</option>)}</select></label>)}</div>
        <Button className="mt-3" disabled={busy} onClick={()=>{void run(async()=>{await submit('validate',{batchId:batch.id,expectedVersion:batch.version,mapping,sourceSystem:source,decisions});setDirty(false);});}}>Validar vista previa de pagos</Button>
      </>}
      <p className="mt-4">{['Valida','Rechazada','Duplicada','Ambigua','Conflicto','Excluida'].map(status=>`${status}: ${batch.preview.filter(row=>row.status===status).length}`).join(' · ')}</p>
      {dirty&&<p className="field-hint">Hay cambios sin validar. La vista previa debe recalcularse antes de confirmar.</p>}
      <div className="table-scroll mt-3"><AdaptiveTable><thead><tr><th>Fila</th><th>Estado / datos</th><th>Resolución explícita</th></tr></thead><tbody>{batch.preview.map(row=><tr key={row.rowNumber}><td>{row.rowNumber}</td>
        <td>{row.status}<small>{row.payload?.reference} · {money(Number(row.payload?.amount??0))}</small><small>{row.error}</small>
          {!!row.similarRows?.length&&<small>Coincide con filas del archivo: {row.similarRows.join(', ')}. Excluya la repetida o justifique un recibo distinto.</small>}</td>
        <td>{!published&&<div className="operation-form"><select aria-label={`Acción de pago fila ${row.rowNumber}`} value={decisions[row.rowNumber]?.action??''} onChange={event=>{setDecisions({...decisions,[row.rowNumber]:{...decisions[row.rowNumber],action:event.target.value}});setDirty(true);}}>
          <option value="">Sin decisión</option><option value="exclude">Excluir con motivo</option><option value="link">Vincular recibo existente</option><option value="create">Crear distinto con motivo</option></select>
          {!!row.candidates.length&&<select aria-label={`Recibo existente fila ${row.rowNumber}`} value={decisions[row.rowNumber]?.paymentId??''} onChange={event=>{setDecisions({...decisions,[row.rowNumber]:{...decisions[row.rowNumber],paymentId:event.target.value}});setDirty(true);}}>
            <option value="">Seleccionar recibo comprobado</option>{row.candidates.map(id=><option key={id}>{id}</option>)}</select>}
          <input aria-label={`Motivo de pago fila ${row.rowNumber}`} placeholder="Motivo de resolución" value={decisions[row.rowNumber]?.reason??''} onChange={event=>{setDecisions({...decisions,[row.rowNumber]:{...decisions[row.rowNumber],reason:event.target.value}});setDirty(true);}}/>
        </div>}</td></tr>)}</tbody></AdaptiveTable></div>
      {!published&&<><p className="mt-4">Nuevos pagos a publicar: <strong>{money(batch.new_total)}</strong></p>
        <label className="form-field"><span>Total conciliado de nuevos pagos</span><input type="number" min="0" step="0.01" value={total} onChange={event=>setTotal(event.target.value)}/></label>
        <Button className="mt-3" disabled={busy||dirty||batch.status!=='Validado'||total===''} onClick={()=>{void run(async()=>{await submit('commit',{batchId:batch.id,expectedVersion:batch.version,expectedTotal:total});await onPublished();});}}>Confirmar publicación atómica de pagos</Button>
      </>}
    </section>}
    <details className="mt-5"><summary>Lotes de pagos guardados</summary>{history.map(batch=><Button key={batch.id} variant="ghost" disabled={busy} onClick={()=>{setBook(null);void run(async()=>{await show(batch);});}}>{batch.file_name} · {batch.status}</Button>)}</details>
    {error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </details>;
}
