import * as XLSX from 'xlsx';

export const IMPORT_LIMITS = {bytes: 5 * 1024 * 1024, expandedBytes: 30 * 1024 * 1024, rows: 500, columns: 50};
export interface SourceRow {rowNumber: number; cells: Record<string, string | number>; hasFormula: boolean;}
export interface SourceSheet {name: string; columns: string[]; rows: SourceRow[];}
export interface ImportWorkbook {fileName: string; base64: string; sheets: SourceSheet[];}

// Bound expanded ZIP size before asking the workbook parser to decompress XLSX.
// ZIP64, encryption and macro projects are deliberately unsupported in the pilot.
export function checkArchive(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (view.getUint32(index, true) === 0x06054b50) {end = index; break;}
  }
  if (end < 0) throw new Error('El archivo XLSX no es un ZIP válido.');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count > 500 || offset === 0xffffffff) throw new Error('Archivo XLSX demasiado complejo o ZIP64 no admitido.');
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP incompleto.');
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    total += size;
    if (size === 0xffffffff || total > IMPORT_LIMITS.expandedBytes || (view.getUint16(offset + 8, true) & 1)
      || /vbaProject\.bin$/i.test(name)) throw new Error('XLSX cifrado, con macros o demasiado grande al descomprimir.');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

export function parseImportWorkbook(fileName: string, buffer: ArrayBuffer): ImportWorkbook {
  if (!/\.(xlsx|csv)$/i.test(fileName)) throw new Error('Solo se admiten archivos XLSX y CSV.');
  if (buffer.byteLength === 0 || buffer.byteLength > IMPORT_LIMITS.bytes) throw new Error('El archivo debe pesar entre 1 byte y 5 MB.');
  const bytes = new Uint8Array(buffer);
  if (/\.xlsx$/i.test(fileName)) checkArchive(bytes);
  else {
    try {new TextDecoder('utf-8', {fatal: true}).decode(bytes);}
    catch {throw new Error('Convertí el CSV a UTF-8 antes de importarlo.');}
    if (bytes.includes(0)) throw new Error('El CSV contiene datos binarios.');
  }
  const workbook = XLSX.read(bytes, {type: 'array', cellDates: false, cellNF: true, cellFormula: true,
    raw: true, sheetRows: IMPORT_LIMITS.rows + 2});
  if (workbook.SheetNames.length > 20) throw new Error('Se admiten hasta 20 hojas por archivo.');
  const sheets = workbook.SheetNames.map((name): SourceSheet => {
    const sheet = workbook.Sheets[name];
    const ref = sheet['!fullref'] ?? sheet['!ref'];
    if (!ref) return {name, columns: [], rows: []};
    const range = XLSX.utils.decode_range(ref);
    if (range.e.c - range.s.c + 1 > IMPORT_LIMITS.columns || range.e.r - range.s.r > IMPORT_LIMITS.rows) {
      throw new Error(`La hoja ${name} excede 500 filas o 50 columnas. Dividí el archivo en lotes acotados.`);
    }
    const columns = Array.from({length: range.e.c - range.s.c + 1}, (_, index) => {
      const value = sheet[XLSX.utils.encode_cell({r: range.s.r, c: range.s.c + index})]?.v;
      return String(value ?? '').trim() || `Columna ${index + 1}`;
    });
    if (new Set(columns).size !== columns.length) throw new Error(`La hoja ${name} tiene encabezados repetidos.`);
    const rows: SourceRow[] = [];
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      let hasFormula = false;
      const cells = Object.fromEntries(columns.map((column, index) => {
        const cell = sheet[XLSX.utils.encode_cell({r, c: range.s.c + index})];
        // Decode Excel calendar serials directly: JS Date conversion can shift the calendar day.
        const calendar = cell?.t === 'n' && XLSX.SSF.is_date(cell.z ?? '')
          ? XLSX.SSF.parse_date_code(cell.v, {date1904: workbook.Workbook?.WBProps?.date1904}) as
            {y: number; m: number; d: number} | null : null;
        const value = calendar ? `${calendar.y}-${String(calendar.m).padStart(2,'0')}-${String(calendar.d).padStart(2,'0')}`
          : cell?.v ?? '';
        const text = String(value);
        if (cell?.f || /^\s*=/.test(text)) hasFormula = true;
        if (text.length > 2000) throw new Error(`La fila ${r + 1} contiene una celda de más de 2000 caracteres.`);
        return [column, typeof value === 'number' && Number.isFinite(value) ? value : text];
      }));
      if (Object.values(cells).some(value => String(value).trim() !== '') || hasFormula) {
        rows.push({rowNumber: r + 1, cells, hasFormula});
      }
    }
    return {name, columns, rows};
  }).filter(sheet => sheet.rows.length > 0);
  if (!sheets.length) throw new Error('El archivo no contiene filas de datos.');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 16384) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 16384));
  }
  return {fileName, base64: btoa(binary), sheets};
}
