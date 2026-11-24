import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliveryActaMoment,deliveryPendingCost,deliveryPendingVersion} from '../src/controladores/workshop-delivery-labels';

test('Delivery review names the pending revision by its folio, never by an internal id',()=>{
  const labels={'quote-1':'PRE-00020 · Versión 2'};
  assert.equal(deliveryPendingVersion('quote-1',labels),'PRE-00020 · Versión 2');
  assert.equal(deliveryPendingVersion(null,labels),'Ninguna');
  assert.doesNotMatch(deliveryPendingVersion('quote-1',labels),/quote-1/);
});

test('Delivery review identifies a pending cost by its description and amount',()=>{
  const row=deliveryPendingCost({id:'c2267d3c',description:'PRUEBA UI taller - filtro',amount:25,disposition:'Pendiente'});
  assert.equal(row,'PRUEBA UI taller - filtro · $25.00');
  assert.doesNotMatch(row,/c2267d3c/);
});

test('Delivery act shows a readable moment instead of a raw timestamp',()=>{
  const moment=deliveryActaMoment('2026-11-23T05:21:33.316957+00:00');
  assert.match(moment,/2026/);
  assert.doesNotMatch(moment,/T05:21:33/);
  assert.equal(deliveryActaMoment(null),'Fecha por revisar');
});
