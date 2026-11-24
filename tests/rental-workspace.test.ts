import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {isRentalPath,rentalSectionHref} from '../src/controladores/rental-workflow';
import {rentalHref} from '../src/lib/supabase/cases';
const source=(path:string)=>readFileSync(path,'utf8');

test('rental destinations use canonical folios and retain all legacy page aliases',()=>{
  assert.match(rentalSectionHref('a/b','Limpieza'),/^\/alquileres\/folio\/\?/);
  assert.equal(rentalHref('a/b'),'/alquileres/folio/?id=a%2Fb');
  for(const path of ['alquileres','alquileres/folio','calendario','vehiculos/reservas','vehiculos/alquiler']){
    assert.ok(existsSync(`src/app/${path}/page.tsx`),path);
    assert.ok(isRentalPath('/'+path));
  }
  assert.equal(isRentalPath('/vehiculos/expediente'),false);
  assert.equal(isRentalPath('/alquileres-other'),false);
});

test('Alquileres and Calendario remain separate navigation modules with orders.read guards',()=>{
  const shell=source('src/components/templates/operational-shell.tsx');
  assert.match(shell,/href:'\/alquileres',label:'Alquileres'.*permission:'orders.read'/);
  assert.match(shell,/href:'\/calendario',label:'Calendario'.*permission:'orders.read'/);
  assert.equal((shell.match(/label:'[^']+',icon:/g)??[]).length,9);
  assert.match(shell,/path==='\/calendario'\?'Calendario':isRentalPath\(path\)/);
  const gate=source('src/components/templates/operational-route-gate.tsx');
  for(const path of ['/alquileres','/alquileres/folio','/calendario','/vehiculos/reservas','/vehiculos/alquiler']){
    assert.ok(gate.includes(`'${path}': 'orders.read'`),path);
  }
});

test('calendar previews navigate to folios instead of duplicating inspection, contract and period forms',()=>{
  const calendar=source('src/components/templates/operational-calendar.tsx');
  for(const component of ['RentalInspectionReview','RentalContracts','RentalPeriods']){
    assert.ok(!calendar.includes(component),component);
  }
  assert.ok(calendar.includes("'Folios'"));assert.ok(calendar.includes('Abrir folio'));
  assert.ok(source('src/components/molecules/page-heading.tsx').includes("'Alquileres'"));
});

test('workspace derives actual return evidence from inspections because reservation rows have no actual-date columns',()=>{
  const calendar=source('src/components/templates/operational-calendar.tsx');
  assert.ok(calendar.includes("readRows<RentalInspection>('rental_inspections'"));
  assert.ok(calendar.includes('actual_return_at:'));
});

test('vehicle rental context is read-only and does not fetch or embed financial command forms',()=>{
  const rentals=source('src/components/organisms/vehicle-rentals.tsx');
  for(const mutation of ['RentalOperation','ReceiptDialog','ReceiptForm','loadRentalCase','rentalRpc','<form']){
    assert.ok(!rentals.includes(mutation),mutation);
  }
  assert.ok(rentals.includes('rentalSectionHref'));
});
