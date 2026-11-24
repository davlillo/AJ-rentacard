import {test} from 'node:test';
import assert from 'node:assert/strict';
import {receptionPayload,receptionErrors} from '../src/controladores/workshop-reception';

const readings={km:'45120',fuel:'75',accessories:'Llanta de repuesto y aires',review:'Vehículo completo, sin daños.'};

test('Workshop reception records the readings instead of a single free text',()=>{
  const payload=receptionPayload('OT-39',readings,45000);
  assert.equal(payload.km,45120);
  assert.equal(payload.fuel,75);
  assert.equal(payload.accessories,'Llanta de repuesto y aires');
  assert.equal(payload.condition,'Vehículo completo, sin daños.');
  assert.equal(payload.orderId,'OT-39');
});

test('Workshop reception never blanks a confirmed odometer and never lowers it',()=>{
  assert.equal(receptionPayload('OT-39',{...readings,km:''},45000).km,45000);
  assert.throws(()=>receptionPayload('OT-39',{...readings,km:'44000'},45000),/no puede ser menor/);
  assert.equal(receptionErrors.kmLower,'El kilometraje no puede ser menor al registrado en el vehículo.');
});

test('Workshop reception refuses readings that are not real facts',()=>{
  assert.throws(()=>receptionPayload('OT-39',{...readings,km:'45.5'},45000),/kilometraje/);
  assert.throws(()=>receptionPayload('OT-39',{...readings,fuel:'120'},45000),/combustible/);
  assert.throws(()=>receptionPayload('OT-39',{...readings,review:'   '},45000),/revisión general/);
});
