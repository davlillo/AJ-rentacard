import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSourceWorkbook} from '../src/controladores/source-workbooks';
import {fleetSourceRows,sourceQuoteLines,workbookSections} from '../src/controladores/workbook-facts';
import {folio} from '../src/controladores/folios';

function book(name:string){const bytes=readFileSync('docs/excels/'+name);return parseSourceWorkbook(name,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}
test('Source-backed fleet retains27realplates and does not fabricate a plate for the continuation',()=>{
  const rows=fleetSourceRows(book('ejemplo calendario carros renta.xlsx').sheets);
  assert.equal(rows.length,28);assert.equal(rows.filter(r=>r.plate).length,27);
  assert.equal(rows[0].plate,'P983527');assert.ok(rows.some(r=>r.customer==='Peña Hermanos'));
  assert.equal(rows.find(r=>r.description==='NISSAN ROGUE 2020 AZUL'&&!r.plate)?.plate,'');
});
test('Real budget has27pricedconcepts totaling2190 and original1440balance without treating750asexpense',()=>{
  const source=book('Ejemplo presupuesto taller.xlsx');const lines=sourceQuoteLines(source.sheets);
  assert.equal(lines.length,27);assert.equal(lines.reduce((sum,line)=>sum+Number(line.unitPrice),0),2190);
  const sections=workbookSections('budget',source.sheets);
  assert.ok(sections.find(s=>s.title==='Resumen del archivo')?.records.some(r=>r.amount.includes('1,440')));
  assert.ok(!sections.find(s=>s.title==='Costos anotados')?.records.some(r=>/abono/i.test(r.title)));
});
test('Readable folios pad actual sequence numbers and never expose or disguise UUIDs',()=>{
  assert.equal(folio('OT','OT-20'),'OT-00020');assert.equal(folio('PRE',22),'PRE-00022');
  assert.equal(folio('ALQ','984d8561-4654-4c58-acd8-92a143644c15'),'ALQ');
});
