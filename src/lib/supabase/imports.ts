import {createSupabaseBrowserClient} from './client';
import type {ImportWorkbook, SourceSheet} from '@/controladores/import-workbook';

export interface ImportSummary {
  valid: number; rejected: number; duplicate: number; ambiguous: number; excluded: number;
  newTotal: number; duplicateTotal: number;
}
export interface ExpenseImport {
  id: string; file_name: string; file_hash: string; sheet_name: string; source_system: string;
  columns: string[]; mapping: ImportMapping; decisions: ImportDecisions;
  status: 'staged' | 'validated' | 'committed'; summary: ImportSummary; version: number; created_at: string;
}
export type ImportMapping = Record<string, string>;
export interface ImportDecision {action: '' | 'new' | 'link' | 'exclude'; reason: string; expenseId?: string;}
export type ImportDecisions = Record<string, ImportDecision>;
export interface ExpenseImportRow {
  id: string; row_number: number; raw_data: {cells: Record<string, string | number>};
  payload: Record<string, string | null> | null;
  status: 'pending' | 'valid' | 'rejected' | 'duplicate' | 'ambiguous' | 'excluded' | 'published';
  issue: string; expense_id: string | null; candidates: string[];
}

const errors: Record<string, string> = {
  PERMISSION_DENIED: 'No tenés permiso para importar o consultar estos archivos.',
  VERSION_CONFLICT: 'El lote cambió. Volvé a abrirlo desde el historial.',
  IMPORT_NOT_EDITABLE: 'El lote ya fue confirmado; no se puede modificar.',
  RECONCILIATION_MISMATCH: 'El total ingresado no coincide con la vista previa.',
  IMPORT_PREVIEW_CHANGED: 'Cambió un dato relacionado. Validá otra vez y revisá la nueva vista previa.',
  IMPORT_HAS_UNRESOLVED_ROWS: 'Resolvé o excluí explícitamente cada fila rechazada o ambigua.',
};
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const {data, error} = await createSupabaseBrowserClient().rpc(name, args);
  if (error) throw new Error(errors[error.message] ?? 'No se pudo procesar el lote. Revisá los datos y la conexión.');
  return data as T;
}
export async function stageImport(book: ImportWorkbook, sheet: SourceSheet): Promise<ExpenseImport> {
  return rpc('stage_expense_import', {file_name: book.fileName, file_base64: book.base64,
    sheet_name: sheet.name, columns: sheet.columns, rows: sheet.rows});
}
export async function validateImport(batch: ExpenseImport, mapping: ImportMapping, source: string,
  decisions: ImportDecisions): Promise<ExpenseImport> {
  return rpc('validate_expense_import', {batch_id: batch.id, expected_version: batch.version,
    mapping, source_system: source, decisions});
}
export async function commitImport(batch: ExpenseImport, total: string): Promise<ExpenseImport> {
  return rpc('commit_expense_import', {batch_id: batch.id, expected_version: batch.version, expected_new_total: total});
}
export async function readImportRows(id: string): Promise<ExpenseImportRow[]> {
  const {data, error} = await createSupabaseBrowserClient().from('expense_import_rows')
    .select('*').eq('import_id', id).order('row_number').range(0, 499).returns<ExpenseImportRow[]>();
  if (error) throw new Error('No se pudo cargar la vista previa.');
  return data;
}
export async function recentImports(): Promise<ExpenseImport[]> {
  const {data, error} = await createSupabaseBrowserClient().from('expense_imports')
    .select('*').order('created_at', {ascending: false}).limit(20).returns<ExpenseImport[]>();
  if (error) throw new Error('No se pudo cargar el historial de importaciones.');
  return data;
}
export async function downloadImportOriginal(batch: ExpenseImport): Promise<void> {
  const base64 = await rpc<string>('expense_import_original', {batch_id: batch.id});
  const bytes = Uint8Array.from(atob(base64.replaceAll('\n', '')), character => character.charCodeAt(0));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes])); link.download = batch.file_name; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
