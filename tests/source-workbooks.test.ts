import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSourceWorkbook} from '../src/controladores/source-workbooks';
function workbook(name:string){const b=readFileSync(`docs/excels/${name}`);return parseSourceWorkbook(name,b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));}
test('Actual diary: all 707 source rows fit; first row and daily summaries remain source, not guessed postings',()=>{
  const b=workbook('LIBRO DIARIO EJEMPLO MAYO 2026.xlsx');
  assert.equal(b.format,'diary');assert.equal(b.sheets[0].rows[0].number,1);
  assert.equal(b.sheets[0].range,'A1:M707');assert.ok(b.items.some(i=>i.row>500));
  assert.equal(b.items.find(i=>i.row===5)?.date,'2026-05-02');
  assert.equal(b.items.find(i=>i.row===18)?.category,'Control');
  assert.equal(Buffer.from(b.base64,'base64').length,readFileSync('docs/excels/LIBRO DIARIO EJEMPLO MAYO 2026.xlsx').length);
});
test('Actual budget: payment750 is not a cost; manual controls1856+334-750=1440 survive',()=>{
  const b=workbook('Ejemplo presupuesto taller.xlsx');assert.equal(b.format,'budget');
  assert.equal(b.items.find(i=>i.row===55)?.category,'Abono por revisar');
  const values=Object.fromEntries(b.sheets[0].rows.flatMap(r=>r.cells.map(c=>[c.address,c.value])));
  assert.equal(Number(values.C80)+Number(values.C81)+Number(values.C82),values.C83);
  assert.equal(values.C83,1440);assert.equal(values.F49,2190);
  assert.equal(b.items.find(i=>i.row===55)?.date,'2026-08-15');
});
test('Actual calendar: 27 plated vehicles, unplated continuation unresolved, 12 open-ended rentals',()=>{
  const b=workbook('ejemplo calendario carros renta.xlsx');assert.equal(b.format,'fleet');
  assert.equal(b.items.filter(i=>i.facts.plate).length,27);assert.equal(b.items.filter(i=>i.facts.openEnded).length,12);
  assert.equal(b.items.find(i=>i.row===18)?.facts.plate,'');
  assert.ok(b.items.find(i=>i.row===18)?.warnings.some(w=>w.includes('Sin placa')));
  assert.equal(new Set(b.items.filter(i=>i.facts.plate).map(i=>i.facts.commercialLine)).size,6);
});
test('Actual receivables preserve first debtor and grouped CCF references without fabricating allocations',()=>{
  const b=workbook('Ejemplo cuadro cuentas por cobrar.xlsx');assert.equal(b.format,'receivables');
  assert.ok(b.items.some(i=>i.row===1));assert.ok(b.items.find(i=>i.row===27)?.description.includes('#069'));
  assert.ok(b.items.find(i=>i.row===27)?.warnings.some(w=>w.includes('varios vehículos')));
});
