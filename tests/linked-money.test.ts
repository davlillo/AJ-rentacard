import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cents,splitRemainder,paymentAvailable,diaryHref,rentalLabel} from '../src/controladores/linked-money';
import {operationMoney} from '../src/controladores/operation-money';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {CustomerPayment,PaymentApplication,PaymentRefund} from '../src/lib/supabase/billing';
import type {BusinessData} from '../src/types';

test('Cash split uses integer cents and rejects fractional cents or incomplete values',()=>{
  assert.equal(splitRemainder('180',['75','100','5']),0);
  assert.equal(splitRemainder('0.30',['0.10','0.20']),0);
  assert.equal(splitRemainder('180',['75','100','4']),100);
  assert.equal(cents('1.001'),null);assert.equal(cents('NaN'),null);assert.equal(cents('-1'),null);assert.equal(cents(''),null);
});
test('A receipt available to apply subtracts applications, reversals and refunds, not another cash event',()=>{
  assert.equal(paymentAvailable({id:'receipt',amount:200} as CustomerPayment,[
    {payment_id:'receipt',amount:100,kind:'Aplicacion'},{payment_id:'receipt',amount:20,kind:'Reversion'}] as PaymentApplication[],
    [{payment_id:'receipt',amount:10}] as PaymentRefund[]),110);
});
test('A shared cash source contributes only its assigned amount to a folio, while delivery and advance states stay distinct',()=>{
  const file={orders:[{id:'OT-1',status:'Entregado'}],expenses:[{amount:180,scope_amount:75}],costs:[{amount:75,disposition:'Pendiente'}],
    documents:[{scope_amount:500,scope_balance:300}],applications:[{kind:'Aplicacion',scope_amount:200}],advances:[{available_amount:25}]} as unknown as CaseFile;
  const summary=operationMoney(file,'OT-1');assert.equal(summary.cashOut,75);assert.equal(summary.costs,75);
  assert.equal(summary.collectionState,'Pago parcial');assert.equal(summary.deliveredWithBalance,true);assert.equal(summary.advances,25);assert.equal(summary.pendingCosts,1);
});
test('Original cash links retain the precise date, source and operation without concatenating unsafe query strings',()=>{
  const url=new URL(diaryHref('OT-1','expense:EG-1','2026-11-02'),'http://localhost');
  assert.equal(url.searchParams.get('operacion'),'OT-1');assert.equal(url.searchParams.get('movimiento'),'expense:EG-1');
  assert.equal(url.searchParams.get('desde'),'2026-11-02');assert.equal(url.searchParams.get('hasta'),'2026-11-02');
});
test('Rental choices identify the real folio, vehicle, customer and dates without presenting a draft as a signed contract',()=>{
  const data={vehicles:[{id:'car',plate:'P-123'}],customers:[{id:'client',name:'Test customer'}],reservationHistory:[
    {id:'rental-uuid',vehicleId:'car',customerId:'client',start:'2026-11-02T10:00:00-06:00',status:'Confirmada',folioNumber:15}]} as BusinessData;
  assert.equal(rentalLabel(data,'rental-uuid'),'Alquiler · ALQ-00015 · P-123 · Test customer · 2026-11-02');
  data.reservationHistory![0].status='Borrador';
  assert.ok(rentalLabel(data,'rental-uuid').startsWith('Reserva · ALQ-00015'));
  data.reservationHistory![0].start='2026-11-03T01:00:00Z';
  assert.ok(rentalLabel(data,'rental-uuid').endsWith('2026-11-02'));
  assert.equal(rentalLabel(data,'unknown'),'Alquiler no disponible');
});
