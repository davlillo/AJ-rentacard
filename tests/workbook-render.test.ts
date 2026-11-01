import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as XLSX from 'xlsx';
import {renderWorkbook} from '../src/controladores/workbook-render';

test('Client Excel rendering preserves the calendar colors, font weights, widths and wrapped headers',()=>{
  const sheet=renderWorkbook(new Uint8Array(readFileSync('docs/excels/ejemplo calendario carros renta.xlsx')))[0];
  assert.equal(sheet.rows,40);assert.equal(sheet.columns.length,9);
  assert.equal(sheet.columns[1],322);assert.equal(sheet.cells.B1.style.backgroundColor,'#9FC5E8');
  assert.equal(sheet.cells.B1.style.fontWeight,700);assert.equal(sheet.cells.C1.style.backgroundColor,'#4A86E8');
  assert.equal(sheet.cells.C1.style.textAlign,'center');assert.ok(sheet.heights[0]>50);
});

test('Client workbook rendering keeps the actual 1440 balance,750 abono,707-row diary and merged cells',()=>{
  const budget=renderWorkbook(new Uint8Array(readFileSync('docs/excels/Ejemplo presupuesto taller.xlsx')))[0];
  assert.equal(budget.rows,84);assert.ok(budget.cells.C83.text.includes('1,440')||budget.cells.C83.text.includes('1440'));
  assert.ok(budget.cells.C55.text.includes('750'));assert.ok(budget.merges.length>0);
  const diary=renderWorkbook(new Uint8Array(readFileSync('docs/excels/LIBRO DIARIO EJEMPLO MAYO 2026.xlsx')))[0];
  assert.equal(diary.rows,707);assert.equal(diary.columns.length,13);assert.ok(diary.cells.C1.text.includes('LIBRO DIARIO'));
});

test('Workbook renderer treats markup/formulas as data and rejects oversized merged ranges',()=>{
  const book=XLSX.utils.book_new();const sheet=XLSX.utils.aoa_to_sheet([['<img src=x onerror=alert(1)>'],[2]]);
  sheet.A2={t:'n',v:2,f:'1+1'};XLSX.utils.book_append_sheet(book,sheet,'Source');
  let bytes=XLSX.write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer;
  const result=renderWorkbook(new Uint8Array(bytes))[0];
  assert.equal(result.cells.A1.text,'<img src=x onerror=alert(1)>');assert.equal(result.cells.A2.formula,'1+1');
  sheet['!merges']=[{s:{r:0,c:0},e:{r:999999,c:1}}];bytes=XLSX.write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer;
  assert.throws(()=>renderWorkbook(new Uint8Array(bytes)),/supera|combinadas/);
});
