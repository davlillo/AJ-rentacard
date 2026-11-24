import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workshopCollectionState} from '../src/controladores/workshop-money-language';

const read=(path:string)=>readFileSync(path,'utf8');

const RECEIPT=read('src/components/organisms/linked-receipt.tsx');
const WORKSHOP_SCREEN=read('src/components/templates/workshop-case-screen.tsx');
const RENTAL_SCREEN=read('src/components/templates/rental-case-screen.tsx');
const RENTAL_ACCOUNTS=read('src/components/organisms/rental-accounts.tsx');
const DELIVERY=read('src/components/organisms/workshop-delivery.tsx');
const INSPECTION=read('src/components/organisms/rental-inspection.tsx');
const STAGE_PROGRESS=read('src/components/organisms/workshop-stage-progress.tsx');
const RENTAL_OPERATION=read('src/components/organisms/rental-operation.tsx');

test('The money surfaces of the rental and the workshop never show cargo, abono or limpieza jargon',()=>{
  for(const [name,source] of [['linked receipt',RECEIPT],['workshop folio',WORKSHOP_SCREEN],
    ['rental folio',RENTAL_SCREEN],['rental accounts',RENTAL_ACCOUNTS],['delivery review',DELIVERY],
    ['rental inspection',INSPECTION]] as const){
    assert.doesNotMatch(source,/Cargo o anticipo|Destino del abono|Importe del abono|Sin cargo\.|a un cargo\b/,
      `${name} still shows accounting jargon`);
  }
  assert.doesNotMatch(RECEIPT,/Cargo/, 'the collection dialog still uses the word cargo');
});

test('The collection dialog asks for the document and the received amount in plain words',()=>{
  assert.match(RECEIPT,/A qué documento se aplica el cobro/);
  assert.match(RECEIPT,/Importe recibido \(USD\)/);
  assert.match(RECEIPT,/Guardar cobro y aplicar al documento/);
});

test('The collection state is spoken in the words of the operator',()=>{
  assert.equal(workshopCollectionState('Sin cargo'),'Sin importe emitido');
  assert.equal(workshopCollectionState('Por emitir'),'Falta emitir el importe a cobrar');
  assert.equal(workshopCollectionState('Pendiente'),'Pendiente de cobro');
});

test('The workshop folio navigates with the circles only: no second tab bar',()=>{
  assert.doesNotMatch(WORKSHOP_SCREEN,/aria-label="Secciones del expediente"/,
    'the workshop folio still shows a second navigation bar');
  assert.match(STAGE_PROGRESS,/utilities/,'the circles do not carry the sections that are not stages');
});

test('The rental folio keeps one collection entry point',()=>{
  assert.doesNotMatch(RENTAL_ACCOUNTS,/>Cobrar saldo pendiente</,
    'the rental folio still offers a second collection button');
  assert.match(RENTAL_ACCOUNTS,/Realizar cobro/,'the collection capability must stay visible');
  assert.match(RENTAL_OPERATION,/Realizar cobro/,'the folio header keeps the collection action');
});
