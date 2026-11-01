import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {localStatus} from '../../scripts/setup-local.mjs';
import {dispatchDueReports} from '../../scripts/report-worker.mjs';
import {setTimeout as delay} from 'node:timers/promises';

test('HU05/HU06 and HU22-HU30 real API, local mail capture and business idempotency',async()=>{
  const status=localStatus();const auth={persistSession:false,autoRefreshToken:false};const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth});
  const run=crypto.randomUUID();
  async function login(role:string){const email=`control-${role}-${run}@aj.local`;const password=crypto.randomUUID()+crypto.randomUUID();
    const created=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(created.error);assert.ok(created.data.user);
    assert.ifError((await admin.from('user_roles').insert({user_id:created.data.user.id,role})).error);
    const client=createClient(status.API_URL,status.ANON_KEY,{auth});assert.ifError((await client.auth.signInWithPassword({email,password})).error);return{client,id:created.data.user.id};}
  const {client:owner,id:ownerId}=await login('owner');const {client:tech}=await login('technician');
  const rpc=async(name:string,args:Record<string,unknown>)=>{const response=await owner.rpc(name,args);assert.ifError(response.error);return response.data;};
  const command=(name:string,command:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>rpc(name,{command,payload,idempotency_key:key});
  try{
    const date=new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
    const customer=await command('execute_command','create_customer',{name:`Control HTTP ${run}`,phone:String(randomInt(10000000,99999999)),type:'Personal'});
    const car=await command('execute_command','create_vehicle',{plate:`CTRL-${run}`,brand:'Test',model:'Control',year:2026,category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    const booking=await command('execute_reservation_command','create',{customerId:customer.id,vehicleId:car.id,startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+2*86400000).toISOString(),dailyRate:'50',cleaningMinutes:0});
    const contract=await command('execute_contract_command','version',{reservationId:booking.id,parentId:null,conditions:'Synthetic conditions preserved in version',reason:'Initial contract'});
    await command('execute_contract_command','accept',{contractId:contract.id,acceptedBy:'Synthetic customer',evidence:'Recorded synthetic signed acceptance reference'});
    assert.equal((await owner.from('rental_contracts').select('booking_snapshot').eq('id',contract.id)).data?.[0].booking_snapshot.customer_snapshot.name,`Control HTTP ${run}`);
    const document=await command('execute_billing_command','issue',{reservationId:booking.id,description:'Eligible rental HTTP',amount:'500',date,dueOn:date});
    const payment=await command('execute_billing_command','pay',{customerId:customer.id,amount:'200',date,method:'Efectivo',account:'Synthetic cashbox',reference:run});
    await command('execute_billing_command','apply',{paymentId:payment.id,documentId:document.id,amount:'200',date});
    await command('execute_commission_command','eligibility',{documentId:document.id,eligible:true,reason:'Commercial service, not guarantee'});
    const rule=await command('execute_commission_command','rule',{code:`SALE-${run}`,rate:'0.10',validFrom:'2020-01-01',validUntil:'2040-01-01'});
    const calculated=await command('execute_commission_command','calculate',{reservationId:booking.id,ruleId:rule.id,cutoff:date});assert.equal(calculated.amount,20);
    assert.equal((await command('execute_commission_command','calculate',{reservationId:booking.id,ruleId:rule.id,cutoff:date})).id,calculated.id);
    await command('execute_billing_command','refund',{paymentId:payment.id,documentId:document.id,amount:'50',date,reason:'Partial service refund'});
    assert.equal((await command('execute_commission_command','calculate',{reservationId:booking.id,ruleId:rule.id,cutoff:date})).amount,-5);
    const order=await command('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Mecánica',service:'Source-grounded assistant HTTP'});
    const expense={operationId:order.id,date,concept:`Agent HTTP ${run}`,category:'Materials',amount:'35.10',method:'Efectivo',account:'Test cashbox'};
    const proposal=await rpc('propose_agent_expense',{payload:expense,idempotency_key:crypto.randomUUID()});
    const confirmations=await Promise.all([1,2].map(()=>owner.rpc('confirm_agent_expense',{proposal_id:proposal.id,expected_hash:proposal.payload_hash})));
    confirmations.forEach(r=>assert.ifError(r.error));assert.equal(confirmations[0].data.id,confirmations[1].data.id);
    assert.equal((await rpc('agent_vehicle_cost',{vehicle_ref:car.id,order_ref:order.id,cutoff:date})).total,35.10);
    assert.equal((await tech.rpc('agent_vehicle_cost',{vehicle_ref:car.id,order_ref:order.id,cutoff:date})).error?.code,'42501');
    assert.equal((await rpc('vehicle_contribution',{vehicle_id:car.id,from_date:date,cutoff:date})).actualDirectCost,35.10);
    const schedule=await command('execute_report_delivery_command','schedule',{recipientId:ownerId,vehicleId:car.id,from:date,nextOn:date,everyDays:7});
    await dispatchDueReports(owner,date);
    let job=await owner.from('report_outbox').select('id,state').eq('schedule_id',schedule.id).single();
    for(let retry=0;job.data?.state==='Enviando'&&retry<30;retry++){
      await delay(200);job=await owner.from('report_outbox').select('id,state').eq('schedule_id',schedule.id).single();
    }
    assert.ifError(job.error);assert.equal(job.data?.state,'Enviado');
    const mailboxUrl=`http://127.0.0.1:55324/api/v1/search?query=${encodeURIComponent('tag:'+job.data!.id)}`;
    const firstMail=await(await fetch(mailboxUrl)).json();assert.equal(firstMail.messages_count,1);
    await dispatchDueReports(owner,date);assert.equal((await(await fetch(mailboxUrl)).json()).messages_count,1);
    const source={customerId:customer.id,date,amount:'12.50',method:'Efectivo',account:'Import cashbox',reference:`Imported ${run}`,sourceKey:run};
    const rows=[{rowNumber:2,cells:source,hasFormula:false}];const mapping=Object.fromEntries(Object.keys(source).map(key=>[key,key]));
    const stage=await command('execute_payment_import','stage',{fileName:`payments-${run}.csv`,sheet:'Payments',base64:Buffer.from(JSON.stringify(rows)).toString('base64'),rows});
    const preview=await command('execute_payment_import','validate',{batchId:stage.id,expectedVersion:stage.version,mapping,sourceSystem:`test-${run}`,decisions:{}});
    const publishes=await Promise.all([1,2].map(()=>owner.rpc('execute_payment_import',{command:'commit',payload:{batchId:preview.id,expectedVersion:preview.version,expectedTotal:'12.50'},idempotency_key:crypto.randomUUID()})));
    publishes.forEach(r=>assert.ifError(r.error));assert.equal(publishes[0].data.id,publishes[1].data.id);
    assert.equal((await owner.from('customer_payments').select('id').eq('reference',source.reference)).data?.length,1);
    const externalPayload={costCenterId:`recover-${run}`,date,concept:`Recovered ${run}`,category:'Test',amount:'12',method:'Efectivo',account:'Test'};
    const event=await command('execute_optional_command','enqueue',{source:'local-test-adapter',externalId:run,event:externalPayload});
    assert.equal((await command('execute_optional_command','process',{eventId:event.id})).state,'Error');
    await command('execute_administration_command','cost_center',{id:externalPayload.costCenterId,name:'Recovery destination',reason:'Approved integration configuration'});
    const processed=await command('execute_optional_command','process',{eventId:event.id});assert.equal(processed.state,'Procesado');
    assert.equal((await command('execute_optional_command','process',{eventId:event.id})).result.id,processed.result.id);
    assert.deepEqual((await tech.from('agent_expense_proposals').select('*').eq('id',proposal.id)).data,[]);
    assert.equal((await tech.rpc('administration_users')).error?.code,'42501');
  }finally{await Promise.all([owner,tech].map(client=>client.auth.signOut({scope:'local'})));}
});
