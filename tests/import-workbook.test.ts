import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {parseImportWorkbook, IMPORT_LIMITS} from '../src/controladores/import-workbook';

const csv = (text: string) => new TextEncoder().encode(text).buffer;
test('HU05 parses CSV with original row numbers, UTF-8 and stable bytes', () => {
  const text = 'date,concept,amount\n2026-10-22,"Pintura, azul",35.10\n';
  const book = parseImportWorkbook('diario.csv',csv(text));
  assert.equal(book.sheets[0].rows[0].rowNumber,2);
  assert.equal(book.sheets[0].rows[0].cells.concept,'Pintura, azul');
  assert.equal(Buffer.from(book.base64,'base64').toString(),text);
});
test('HU05 reads selected-sheet candidates and flags formulas even with cached values', () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Date','Amount'],[new Date(2026,9,22),35.1]]);
  sheet.B2 = {t:'n',v:35.1,f:'SUM(35.1)'};
  XLSX.utils.book_append_sheet(book,sheet,'Ledger');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Other'],['Text']]),'Other');
  const parsed = parseImportWorkbook('book.xlsx',XLSX.write(book,{type:'array',bookType:'xlsx'}));
  assert.equal(parsed.sheets.length,2);
  assert.equal(parsed.sheets[0].rows[0].hasFormula,true);
  assert.equal(parsed.sheets[0].rows[0].cells.Date,'2026-10-22');
});
test('HU05 rejects ambiguous headers, unsupported files and excessive payloads', () => {
  assert.throws(() => parseImportWorkbook('file.csv',csv('A,A\n1,2')),/encabezados/);
  assert.throws(() => parseImportWorkbook('file.xlsm',csv('A\n1')),/XLSX y CSV/);
  assert.throws(() => parseImportWorkbook('file.xlsx',csv('not a workbook')),/ZIP/);
  assert.throws(() => parseImportWorkbook('file.csv',new ArrayBuffer(IMPORT_LIMITS.bytes+1)),/5 MB/);
  assert.throws(() => parseImportWorkbook('file.csv',csv('A\n'+Array(501).fill('1').join('\n'))),/500 filas/);
  assert.equal(parseImportWorkbook('formula.csv',csv('Amount\n=SUM(A1)')).sheets[0].rows[0].hasFormula,true);
});
