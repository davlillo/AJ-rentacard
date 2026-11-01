import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {createClient} from '@supabase/supabase-js';
import {localStatus} from '../../scripts/setup-local.mjs';

test('Review fixes: real HTTP payment concurrency, trusted PDF and return-linked release',async()=>{
  const status=localStatus();const auth={persistSession:false,autoRefreshToken:false};
  const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth});const run=crypto.randomUUID();
  const email=`review-${run}@aj.local`;const password=crypto.randomUUID()+crypto.randomUUID();
  const user=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(user.error);assert.ok(user.data.user);
  assert.ifError((await admin.from('user_roles').insert({user_id:user.data.user.id,role:'owner'})).error);
  const client=createClient(status.API_URL,status.ANON_KEY,{auth});
  assert.ifError((await client.auth.signInWithPassword({email,password})).error);
  async function command(fn:string,command:string,payload:Record<string,unknown>,key=crypto.randomUUID()){
    const response=await client.rpc(fn,{command,payload,idempotency_key:key});assert.ifError(response.error);return response.data;
  }
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
  try{
    const customer=await command('execute_command','create_customer',{name:`Review HTTP ${run}`,phone:String(randomInt(10000000,99999999)),type:'Personal'});
    const car=await command('execute_command','create_vehicle',{plate:`REV-COST-${run}`,brand:'Test',model:'Review',year:2026,category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    const order=await command('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Mecánica',service:'Review linked payment'});
    const cost=await command('execute_cost_command','purchase',{orderId:order.id,description:'Review part',quantity:'1',unitCost:'100',
      supplier:`Review supplier ${run}`,sourceReference:`INV-${run}`,date});
    const pay={cost_id:cost.id,payload:{date,amount:'60',method:'Efectivo',account:'Review HTTP cash'},idempotency_key:crypto.randomUUID()};
    const raced=await Promise.all([client.rpc('pay_direct_purchase',pay),client.rpc('pay_direct_purchase',pay)]);
    raced.forEach(result=>assert.ifError(result.error));assert.equal(raced[0].data.id,raced[1].data.id);
    const remaining={...pay,payload:{...pay.payload,amount:'40'}};
    const overpayRace=await Promise.all([client.rpc('pay_direct_purchase',{...remaining,idempotency_key:crypto.randomUUID()}),
      client.rpc('pay_direct_purchase',{...remaining,idempotency_key:crypto.randomUUID()})]);
    assert.equal(overpayRace.filter(result=>!result.error).length,1);
    assert.equal(overpayRace.filter(result=>result.error?.message==='DIRECT_PURCHASE_OVERPAYMENT').length,1);
    const costs=await client.from('workshop_costs').select('id,amount').eq('order_id',order.id);assert.ifError(costs.error);
    assert.equal(costs.data?.length,1);assert.equal(costs.data?.[0].amount,100);
    const payment={customerId:customer.id,date,amount:'20',method:'Efectivo',account:'Review receipt',reference:run,sourceKey:'A'};
    const batch=await command('execute_payment_import','stage',{fileName:`review-${run}.csv`,sheet:'Payments',base64:Buffer.from(run).toString('base64'),
      rows:[{rowNumber:2,cells:payment},{rowNumber:3,cells:{...payment,sourceKey:'B'}}]});
    let preview=await command('execute_payment_import','validate',{batchId:batch.id,expectedVersion:batch.version,
      mapping:Object.fromEntries(Object.keys(payment).map(key=>[key,key])),sourceSystem:run,decisions:{}});
    assert.deepEqual(preview.preview.map((row:{status:string})=>row.status),['Valida','Ambigua']);
    assert.equal((await client.rpc('execute_payment_import',{command:'commit',payload:{batchId:batch.id,expectedVersion:preview.version,expectedTotal:'20'},
      idempotency_key:crypto.randomUUID()})).error?.message,'UNRESOLVED_IMPORT_ROWS');
    preview=await command('execute_payment_import','validate',{batchId:batch.id,expectedVersion:preview.version,mapping:preview.mapping,
      sourceSystem:run,decisions:{3:{action:'exclude',reason:'Confirmed duplicate row in same file'}}});
    await command('execute_payment_import','commit',{batchId:batch.id,expectedVersion:preview.version,expectedTotal:'20'});
    const rentalCar=await command('execute_command','create_vehicle',{plate:`REV-RENT-${run}`,brand:'Test',model:'Review',year:2026,category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    let booking=await command('execute_reservation_command','create',{customerId:customer.id,vehicleId:rentalCar.id,
      startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:'50',cleaningMinutes:30});
    booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
    const contract=await command('execute_contract_command','version',{reservationId:booking.id,parentId:null,
      conditions:'Condición congelada para devolución. '.repeat(150),reason:'Review HTTP frozen contract'});
    assert.equal((await client.rpc('contract_pdf',{contract_id:contract.id,pdf_base64:Buffer.from('%PDF-not-a-document').toString('base64')})).error?.message,'INVALID_PDF_UPLOAD');
    const stored=await client.rpc('contract_pdf',{contract_id:contract.id});assert.ifError(stored.error);
    const bytes=Buffer.from(stored.data.base64,'base64');
    assert.ok((await PDFDocument.load(bytes,{throwOnInvalidObject:true})).getPageCount()>1);
    assert.equal(stored.data.hash,createHash('sha256').update(bytes).digest('hex'));
    const inspection={reservationId:booking.id,km:'0',fuel:'100',condition:'No change',accessories:'None',evidence:'Review HTTP handover'};
    const departure=await command('execute_rental_command','depart',{...inspection,expectedVersion:booking.version});
    await command('execute_rental_command','return',{...inspection,expectedVersion:departure.reservation.version});
    const cleaning=await client.from('vehicle_commitments').select('id').eq('reservation_id',booking.id).eq('kind','Limpieza');assert.ifError(cleaning.error);
    assert.equal(cleaning.data?.length,1);
    await command('execute_reservation_command','finish_block',{blockId:cleaning.data![0].id,reason:'Return inspected and cleaning completed'});
    const state=await client.from('vehicles').select('readiness_hold,status').eq('id',rentalCar.id).single();assert.ifError(state.error);
    assert.equal(state.data.readiness_hold,false);assert.equal(state.data.status,'Disponible');
    assert.equal((await client.rpc('execute_reservation_command',{command:'finish_block',payload:{blockId:cleaning.data![0].id,reason:'Cannot finish inactive block again'},
      idempotency_key:crypto.randomUUID()})).error?.message,'BLOCK_CANNOT_BE_FINISHED');
  }finally{await client.auth.signOut({scope:'local'});}
});
