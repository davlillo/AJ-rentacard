import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {localStatus} from '../../scripts/setup-local.mjs';

test('Operational fit: real HTTP dossier, manual scope, atomic collection and cash diary',async()=>{
  const status=localStatus();const auth={persistSession:false,autoRefreshToken:false};const run=crypto.randomUUID();
  const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth});const email=`cases-${run}@aj.local`;
  const password=crypto.randomUUID()+crypto.randomUUID();const user=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(user.error);
  assert.ifError((await admin.from('user_roles').insert({user_id:user.data.user!.id,role:'owner'})).error);
  const client=createClient(status.API_URL,status.ANON_KEY,{auth});assert.ifError((await client.auth.signInWithPassword({email,password})).error);
  async function rpc<T=Record<string,unknown>>(name:string,args:Record<string,unknown>):Promise<T>{const r=await client.rpc(name,args);assert.ifError(r.error);return r.data as T;}
  const command=<T=Record<string,unknown>>(name:string,action:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>rpc<T>(name,{command:action,payload,idempotency_key:key});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:`Case HTTP ${run}`,phone:String(randomInt(10000000,99999999)),type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:`CASE-HTTP-${run}`,brand:'Nissan',model:'Rogue',year:2018,category:'SUV',color:'White',daily:'0',km:'0',ownership:'Cliente',ownerCustomerId:customer.id});
    const job=await command<{id:string}>('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Pintura',service:'Synthetic Excel acceptance'});
    const q=await command<{id:string}>('execute_case_command','quote',{orderId:job.id,parentId:null,reason:'Reviewed scope2190',lines:[{description:'Repair scope',kind:'Trabajo',quantity:'1',unitPrice:'2190',unitCost:null}]});
    await command('execute_estimate_command','approve',{estimateId:q.id,approverName:'Synthetic customer',evidence:'Written approval'});
    const document=await command<{id:string}>('execute_case_command','bill_scope',{orderId:job.id,date:today,dueOn:today});
    const collect={orderId:job.id,documentId:document.id,amount:'750',date:today,method:'Efectivo',account:`Case HTTP ${run}`,reference:'One real HTTP receipt'};
    const key=crypto.randomUUID();
    const race=await Promise.all([command('execute_case_command','collect',collect,key),command('execute_case_command','collect',collect,key)]);
    assert.deepEqual(race[0],race[1]);
    const dossier=await rpc<{documents:{scope_balance:number}[];expenses:unknown[]}>('vehicle_case_file',{vehicle_id:car.id,order_id:job.id});
    assert.equal(dossier.documents[0].scope_balance,1440);assert.equal(dossier.expenses.length,0);
    const failed=await client.rpc('execute_case_command',{command:'collect',payload:{...collect,amount:'2000'},idempotency_key:crypto.randomUUID()});
    assert.equal(failed.error?.message,'PAYMENT_EXCEEDS_AVAILABLE_BALANCE');
    const receipts=await client.from('customer_payments').select('id').eq('customer_id',customer.id);assert.ifError(receipts.error);assert.equal(receipts.data?.length,1);
    const diary=await rpc<{rows:{source_type:string}[];income:number;balanceAfter:null}>('cash_diary',{from_date:today,to_date:today,account_filter:`Case HTTP ${run}`});
    assert.equal(diary.rows.length,1);assert.equal(diary.income,750);assert.equal(diary.balanceAfter,null);
    const own=await command<{id:string}>('execute_command','create_vehicle',{plate:`FLEET-HTTP-${run}`,brand:'Test',model:'Open',year:2026,category:'SUV',color:'White',daily:'40',km:'0',ownership:'Propio'});
    let booking=await command<{id:string;version:number}>('execute_reservation_command','create',{vehicleId:own.id,customerId:customer.id,startsAt:`${today}T00:00:00-06:00`,openEnded:true,dailyRate:'40'});
    booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
    const commitments=await client.from('vehicle_commitments').select('ends_at').eq('reservation_id',booking.id);assert.ifError(commitments.error);assert.equal(commitments.data?.[0].ends_at,'infinity');
    const file=await rpc<{id:string}>('save_vehicle_file',{payload:{vehicleId:car.id,orderId:job.id,name:'one-pixel.png',mime:'image/png',purpose:'Ingreso',
      base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='},idempotency_key:crypto.randomUUID()});
    assert.ok(file.id);
    const anonymous=createClient(status.API_URL,status.ANON_KEY,{auth});
    assert.ok((await anonymous.rpc('vehicle_file_content',{file_id:file.id})).error);
  }finally{await client.auth.signOut({scope:'local'});}
});
