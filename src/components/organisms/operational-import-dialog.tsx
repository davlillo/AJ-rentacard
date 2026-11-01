'use client';
import {useEffect, useRef, useState} from 'react';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {useBusiness} from '@/hooks/use-business';
import {parseImportWorkbook, type ImportWorkbook} from '@/controladores/import-workbook';
import {money} from '@/controladores/finanzas';
import {exportCSV} from '@/controladores/reportes';
import {stageImport, validateImport, commitImport, readImportRows, recentImports, downloadImportOriginal,
  type ExpenseImport, type ExpenseImportRow, type ImportDecisions, type ImportMapping, type ImportDecision} from '@/lib/supabase/imports';
import {AdaptiveTable} from './adaptive-table';

const fields = [
  ['date','Fecha','fecha'],['concept','Concepto','concepto'],['amount','Monto','monto'],
  ['category','Categoría','categoria'],['method','Medio de pago','medio'],['account','Cuenta o caja','cuenta'],
  ['operationId','Folio de operación','operacion'],['costCenterId','Centro de costo','centro_costo'],
  ['sourceKey','Identificador de origen','id_origen'],['type','Tipo (opcional)','tipo'],
  ['currency','Moneda (opcional)','moneda'],['support','Referencia de soporte (opcional)','soporte'],
];
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll(' ', '_');
const rowLabels: Record<ExpenseImportRow['status'], string> = {
  pending:'Pendiente',valid:'Válida',rejected:'Rechazada',duplicate:'Duplicada',ambiguous:'Ambigua',excluded:'Excluida',published:'Publicada',
};

export function OperationalImportDialog() {
  const {close, refresh, toast} = useBusiness();
  const [book, setBook] = useState<ImportWorkbook | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [batch, setBatch] = useState<ExpenseImport | null>(null);
  const [history, setHistory] = useState<ExpenseImport[]>([]);
  const [rows, setRows] = useState<ExpenseImportRow[]>([]);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [source, setSource] = useState('daily-ledger');
  const [decisions, setDecisions] = useState<ImportDecisions>({});
  const [dirty, setDirty] = useState(true);
  const [total, setTotal] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const committed = batch?.status === 'committed';
  useEffect(() => {void recentImports().then(setHistory).catch(error => setError(error.message));}, []);

  async function run(action: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {await action();} catch (error) {setError((error as Error).message);}
    finally {sending.current = false; setBusy(false);}
  }
  async function show(next: ExpenseImport) {
    const [preview, previousImports] = await Promise.all([readImportRows(next.id), recentImports()]);
    setBatch(next); setRows(preview); setDecisions(next.decisions);
    setSource(next.source_system); setTotal(''); setConfirmed(false); setDirty(next.status === 'staged');
    const defaults = Object.fromEntries(fields.map(([field,,example]) =>
      [field, next.columns.find(column => normalize(column) === example || normalize(column) === normalize(field)) ?? '']));
    setMapping(Object.keys(next.mapping).length ? next.mapping : {...defaults,dateFormat:'ISO',decimalSeparator:'.'});
    setHistory(previousImports);
  }
  function edited() {setDirty(true); setConfirmed(false); setTotal('');}
  function decide(row: number, values: Partial<ImportDecision>) {
    setDecisions(previous => ({...previous,[row]:{...(previous[row] ?? {action:'',reason:''}),...values}})); edited();
  }
  return <Dialog open onOpenChange={open => !open && !busy && close()}><DialogContent className="max-w-5xl" closeDisabled={busy} aria-busy={busy}>
    <DialogTitle className="text-2xl font-semibold">Importar gastos del diario</DialogTitle>
    <DialogDescription className="text-sm text-muted-foreground mt-1">Archivo → hoja y columnas → validación → conciliación → confirmación.</DialogDescription>
    <p className="inline-note mt-4">Solo egresos en USD. Los pagos se importan por separado desde Cuentas por cobrar.
      No se ejecutan fórmulas ni macros. Máximo 5 MB, 500 filas y 50 columnas por hoja.</p>
    <div className="operation-form">
      <label className="form-field"><span>Archivo XLSX o CSV UTF-8</span><input type="file" accept=".xlsx,.csv" disabled={busy}
        onChange={event => {
          const file = event.target.files?.[0]; if (!file) return;
          void run(async () => {
            if (file.size > 5 * 1024 * 1024) throw new Error('El archivo excede 5 MB.');
            const parsed = parseImportWorkbook(file.name, await file.arrayBuffer());
            setBook(parsed); setSheetName(parsed.sheets[0].name); setBatch(null); setRows([]); edited();
          });
        }}/></label>
      <Button variant="ghost" disabled={busy} onClick={() => exportCSV('plantilla-gastos', [{
        fecha:'2026-10-22',concepto:'Ejemplo de gasto',monto:'35.10',categoria:'Materiales',medio:'Efectivo',cuenta:'Caja principal',
        operacion:'',centro_costo:'administration',id_origen:'EJEMPLO-1',moneda:'USD',tipo:'Egreso',soporte:'Referencia',
      }])}>Descargar plantilla CSV</Button>
      {book && <div className="form-grid"><label className="form-field"><span>Hoja</span>
        <select disabled={busy} value={sheetName} onChange={event => setSheetName(event.target.value)}>
          {book.sheets.map(sheet => <option key={sheet.name}>{sheet.name}</option>)}
        </select></label><Button disabled={busy} onClick={() => {void run(async () => {
          const sheet = book.sheets.find(sheet => sheet.name === sheetName)!;
          await show(await stageImport(book, sheet));
        });}}>Preparar lote privado</Button></div>}
      {history.length > 0 && <label className="form-field"><span>Reabrir un lote reciente</span>
        <select disabled={busy} value={batch?.id ?? ''} onChange={event => {
          const found = history.find(batch => batch.id === event.target.value);
          if (found) void run(() => show(found));
        }}><option value="">Seleccionar lote</option>{history.map(batch =>
          <option key={batch.id} value={batch.id}>{batch.file_name} · {batch.sheet_name} · {batch.status} · {batch.id.slice(0,8)}</option>)}
        </select></label>}
      {batch && <>
        <section className="inline-note"><strong>{batch.file_name} / {batch.sheet_name}</strong>
          <p>Lote {batch.id} · versión {batch.version} · {batch.status}</p>
          <small className="break-all">SHA-256 {batch.file_hash}</small></section>
        {!committed && <fieldset disabled={busy}>
          <h3 className="font-semibold mb-3">Mapear columnas</h3><div className="form-grid">
            {fields.map(([field,label]) => <label className="form-field" key={field}><span>{label}</span>
              <select value={mapping[field] ?? ''} onChange={event => {setMapping({...mapping,[field]:event.target.value}); edited();}}>
                <option value="">Sin columna</option>{batch.columns.map(column => <option key={column}>{column}</option>)}
              </select></label>)}
          </div>
          <label className="form-field"><span>Sistema de origen (conservá el mismo para libros relacionados)</span>
            <input value={source} maxLength={100} onChange={event => {setSource(event.target.value); edited();}}/></label>
          <div className="form-grid">
            <label className="form-field"><span>Fechas de texto</span><select value={mapping.dateFormat ?? 'ISO'}
              onChange={event => {setMapping({...mapping,dateFormat:event.target.value}); edited();}}>
              <option value="ISO">AAAA-MM-DD</option><option value="DMY">DD/MM/AAAA o AAAA-MM-DD</option></select></label>
            <label className="form-field"><span>Separador decimal de texto</span><select value={mapping.decimalSeparator ?? '.'}
              onChange={event => {setMapping({...mapping,decimalSeparator:event.target.value}); edited();}}>
              <option value=".">Punto: 1,234.56</option><option value=",">Coma: 1.234,56</option></select></label>
          </div>
          <Button variant="outline" className="mt-3" onClick={() => {void run(async () => {
            await show(await validateImport(batch, mapping, source, decisions));
          });}}>Validar y guardar vista previa</Button>
        </fieldset>}
        {batch.status !== 'staged' && <>
          <div className="import-summary"><span>{committed ? 'Publicadas' : 'Válidas'}: {batch.summary.valid}</span>
            <span>Rechazadas: {batch.summary.rejected}</span><span>Duplicadas: {batch.summary.duplicate}</span>
            <span>Ambiguas: {batch.summary.ambiguous}</span><span>Excluidas: {batch.summary.excluded}</span></div>
          <div className="table-scroll"><AdaptiveTable><thead><tr><th>Fila</th><th>Origen / importe</th><th>Estado e incidencia</th>
            <th>{committed ? 'Folio' : 'Resolución explícita'}</th></tr></thead><tbody>{rows.map(row => {
            const decision = decisions[row.row_number];
            return <tr key={row.id}><td>{row.row_number}</td><td>
              <strong>{row.payload?.concept ?? 'Sin normalizar'}</strong><small>{row.payload?.amount ?? 'Sin registrar'}</small>
              <details><summary>Datos originales</summary><pre className="text-xs whitespace-pre-wrap">{JSON.stringify(row.raw_data.cells,null,2)}</pre></details>
            </td><td><Badge tone={row.status === 'rejected' || row.status === 'ambiguous' ? 'amber' : 'green'}>{rowLabels[row.status]}</Badge>
              <small>{row.issue}</small></td><td>{committed ? row.expense_id ?? 'Sin publicación' : <>
              <select aria-label={`Acción fila ${row.row_number}`} disabled={busy} value={decision?.action ?? ''}
                onChange={event => decide(row.row_number,{action:event.target.value as ImportDecision['action']})}>
                <option value="">Sin decisión adicional</option><option value="exclude">Excluir esta fila</option>
                <option value="new">Es un gasto nuevo</option>{row.candidates.length > 0 && <option value="link">Vincular gasto existente</option>}
              </select>
              {decision?.action === 'link' && <select aria-label={`Gasto existente fila ${row.row_number}`} disabled={busy}
                value={decision.expenseId ?? ''} onChange={event => decide(row.row_number,{expenseId:event.target.value})}>
                <option value="">Seleccionar folio</option>{row.candidates.map(id => <option key={id}>{id}</option>)}
              </select>}
              {decision?.action && <input aria-label={`Motivo fila ${row.row_number}`} placeholder="Motivo obligatorio" disabled={busy}
                value={decision.reason} onChange={event => decide(row.row_number,{reason:event.target.value})}/>}
            </>}</td></tr>;
          })}</tbody></AdaptiveTable></div>
          <p className="calculation"><span>Total nuevo a publicar</span><strong>{money(Number(batch.summary.newTotal))}</strong></p>
          {!committed && <>
            {dirty && <p role="status" className="inline-note">Hay cambios sin validar. Guardá una nueva vista previa antes de confirmar.</p>}
            <label className="form-field"><span>Ingresá el total nuevo conciliado con tu archivo (USD, sin separador de miles)</span>
              <input type="number" min="0" step="0.01" disabled={busy} value={total} onChange={event => setTotal(event.target.value)}/></label>
            <label><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>
              Revisé importes, destinos, duplicados y exclusiones. Confirmo publicar únicamente las filas válidas.</label>
            <Button disabled={busy || dirty || !confirmed || total === '' || batch.summary.rejected > 0 || batch.summary.ambiguous > 0}
              onClick={() => {void run(async () => {
                const committedBatch = await commitImport(batch, total);
                await show(committedBatch);
                await refresh().catch(() => toast('El lote se confirmó. Actualizá el diario para ver los movimientos.'));
                toast(`Lote confirmado · ${committedBatch.id}`);
              });}}>{busy ? 'Procesando…' : 'Confirmar publicación del lote'}</Button>
          </>}
          <div className="form-grid"><Button variant="outline" disabled={busy} onClick={() => exportCSV('resultado-importacion',rows.map(row => ({
            fila:row.row_number,estado:row.status,incidencia:row.issue,folio:row.expense_id ?? '',importe:row.payload?.amount ?? '',
          })))}>Descargar resultado CSV</Button><Button variant="outline" disabled={busy}
            onClick={() => {void run(() => downloadImportOriginal(batch));}}>Descargar archivo original</Button></div>
        </>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-footer"><Button disabled={busy} variant="outline" onClick={close}>Cerrar</Button></div>
    </div>
  </DialogContent></Dialog>;
}
