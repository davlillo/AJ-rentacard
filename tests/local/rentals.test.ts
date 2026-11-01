import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {localStatus} from '../../scripts/setup-local.mjs';

test('HU13-HU19 local HTTP concurrency, inspections and immutable receivables',async()=>{
  const status=localStatus();const auth={persistSession:false,autoRefreshToken:false};
  const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth});const run=crypto.randomUUID();
  async function login(role:string){
    const email=`rental-${role}-${run}@aj.local`;const password=crypto.randomUUID()+crypto.randomUUID();
    const user=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(user.error);assert.ok(user.data.user);
    assert.ifError((await admin.from('user_roles').insert({user_id:user.data.user.id,role})).error);
    const client=createClient(status.API_URL,status.ANON_KEY,{auth});assert.ifError((await client.auth.signInWithPassword({email,password})).error);return client;
  }
  const owner=await login('owner');const tech=await login('technician');const reception=await login('reception');
  const core=(command:string,payload:Record<string,unknown>)=>owner.rpc('execute_command',{command,payload,idempotency_key:crypto.randomUUID()});
  const reserve=(command:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>owner.rpc('execute_reservation_command',{command,payload,idempotency_key:key});
  const bill=(command:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>owner.rpc('execute_billing_command',{command,payload,idempotency_key:key});
  try{
    const customer=await core('create_customer',{name:`Rental HTTP ${run}`,phone:String(randomInt(10000000,99999999)),type:'Personal'});assert.ifError(customer.error);
    const car=await core('create_vehicle',{plate:`RENT-${run}`,brand:'Test',model:'Rental',year:2026,category:'Sedán',color:'White',daily:50,km:100,ownership:'Propio'});assert.ifError(car.error);
    const input={customerId:customer.data.id,vehicleId:car.data.id,startsAt:new Date(Date.now()-3600000).toISOString(),
      endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:'50',cleaningMinutes:30};
    const drafts=await Promise.all([reserve('create',input),reserve('create',input)]);drafts.forEach(r=>assert.ifError(r.error));
    const race=await Promise.all(drafts.map(d=>reserve('confirm',{reservationId:d.data.id,expectedVersion:d.data.version})));
    assert.equal(race.filter(r=>!r.error).length,1);assert.equal(race.filter(r=>r.error?.code==='23P01').length,1);
    let booking=race.find(r=>!r.error)!.data;
    const evidence=await reserve('evidence',{reservationId:booking.id,body:'WhatsApp agreement preserved'});assert.ifError(evidence.error);
    assert.ok(evidence.data.created_by);assert.ok(evidence.data.created_at);
    const second=await reserve('create',{...input,startsAt:new Date(Date.now()+2*86400000).toISOString(),endsAt:new Date(Date.now()+3*86400000).toISOString()});assert.ifError(second.error);
    assert.ifError((await reserve('confirm',{reservationId:second.data.id,expectedVersion:second.data.version})).error);
    assert.equal((await reserve('extend',{reservationId:booking.id,expectedVersion:booking.version,endsAt:new Date(Date.now()+2.5*86400000).toISOString(),reason:'Conflicting requested extension'})).error?.code,'23P01');
    const inspection={reservationId:booking.id,expectedVersion:booking.version,km:'100',fuel:'100',condition:'No damage',accessories:'Spare tire',evidence:'Synthetic handover'};
    const departed=await owner.rpc('execute_rental_command',{command:'depart',payload:inspection,idempotency_key:crypto.randomUUID()});assert.ifError(departed.error);booking=departed.data.reservation;
    const returned=await owner.rpc('execute_rental_command',{command:'return',payload:{...inspection,expectedVersion:booking.version,km:'150',fuel:'80',condition:'New dent'},idempotency_key:crypto.randomUUID()});assert.ifError(returned.error);
    assert.equal((await owner.from('rental_extra_proposals').select('status').eq('reservation_id',booking.id)).data?.[0].status,'Propuesto');
    const date=new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
    const document=await bill('issue',{reservationId:booking.id,description:'Rental charge HTTP',amount:'500',date,dueOn:date});assert.ifError(document.error);
    const payment=await bill('pay',{customerId:customer.data.id,amount:'200',date,method:'Efectivo',account:'Test cashbox',reference:`REC-${run}`});assert.ifError(payment.error);
    const key=crypto.randomUUID();const apply={paymentId:payment.data.id,documentId:document.data.id,amount:'200',date};
    const applied=await Promise.all([bill('apply',apply,key),bill('apply',apply,key)]);applied.forEach(r=>assert.ifError(r.error));assert.equal(applied[0].data.id,applied[1].data.id);
    assert.equal((await bill('apply',{...apply,amount:'1'})).error?.message,'PAYMENT_EXCEEDS_AVAILABLE_BALANCE');
    const balances=await owner.rpc('receivables_at',{cutoff:date});assert.ifError(balances.error);
    assert.equal(balances.data.find((d:{id:string})=>d.id===document.data.id).balance,300);
    assert.equal((await reception.rpc('reservation_payment_status',{reservation_id:booking.id})).data,'Parcial');
    assert.deepEqual((await reception.from('customer_payments').select('*').eq('id',payment.data.id)).data,[]);
    assert.deepEqual((await tech.from('reservations').select('*').eq('id',booking.id)).data,[]);
    assert.equal((await tech.rpc('receivables_at',{cutoff:date})).error?.code,'42501');
    const inventory=(command:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>owner.rpc('execute_inventory_command',{command,payload,idempotency_key:key});
    const item=await inventory('item',{sku:`SKU-${run}`,name:'Synthetic brake pad',unit:'unit'});assert.ifError(item.error);
    let purchase=await inventory('request',{itemId:item.data.id,supplier:'Synthetic supplier',quantity:'5',unitCost:'10',reason:'HTTP replenish'});assert.ifError(purchase.error);
    purchase=await inventory('authorize',{purchaseId:purchase.data.id,expectedVersion:purchase.data.version,reason:'Owner authorization'});assert.ifError(purchase.error);
    const receiptKey=crypto.randomUUID();const receiptPayload={purchaseId:purchase.data.id,expectedVersion:purchase.data.version,quantity:'3',reason:'Partial HTTP receipt'};
    const receipts=await Promise.all([inventory('receive',receiptPayload,receiptKey),inventory('receive',receiptPayload,receiptKey)]);receipts.forEach(r=>assert.ifError(r.error));assert.equal(receipts[0].data.id,receipts[1].data.id);
    assert.equal((await owner.from('stock_items').select('quantity').eq('id',item.data.id)).data?.[0].quantity,3);
    assert.equal((await owner.from('supplier_obligations').select('id').eq('purchase_id',purchase.data.id)).data?.length,1);
    assert.deepEqual((await tech.from('stock_items').select('*').eq('id',item.data.id)).data,[]);
  }finally{await Promise.all([owner,reception,tech].map(client=>client.auth.signOut({scope:'local'})));}
});
