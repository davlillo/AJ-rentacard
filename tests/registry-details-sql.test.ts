import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('Known details can be completed with evidence, version checks and authorization without inventing physical readiness',async()=>{
  const {db,command,rpc,asUser,technician}=await operationalDb();
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Source contact',phone:'',type:'Personal'});
    const unknown=await command<{id:string}>('execute_command','create_vehicle',{plate:'',brand:'Nissan',model:'Rogue',year:2018,
      category:'SUV',color:'',daily:0,km:0,ownership:'Por confirmar',initialStatus:'Por confirmar',unverifiedFields:['plate','color','daily','km','ownership','status']});
    const fresh=(await db.query<{status:string;unverified_fields:string[]}>('select status,unverified_fields from public.vehicles where id=$1',[unknown.id])).rows[0];
    assert.equal(fresh.status,'Por confirmar');assert.ok(fresh.unverified_fields.includes('km'));assert.ok(fresh.unverified_fields.includes('daily'));
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'',brand:'Nissan',model:'Rogue',year:2018,category:'SUV',color:'',daily:'0',km:'0',ownership:'Por confirmar',inRentalFleet:true});
    await db.exec('reset role');await db.query("update public.vehicles set status='Por confirmar',unverified_fields=array['plate','color','km','daily','status'] where id=$1",[car.id]);await db.exec('set role authenticated');
    const vehicle=(await db.query<{version:number}>('select version from public.vehicles where id=$1',[car.id])).rows[0];
    const payload={id:car.id,expectedVersion:vehicle.version,status:'Disponible',reason:'Physical verification'};
    await assert.rejects(rpc('save_registry_details',{kind:'vehicle',payload:JSON.stringify(payload),idempotency_key:crypto.randomUUID()}),/CONFIRMED_ODOMETER_REQUIRED/);
    const key=crypto.randomUUID();const body={...payload,km:'24000',daily:'35',plate:'VERIFIED-1',color:'White'};
    const saved=await rpc<{version:number;unverified_fields:string[]}>('save_registry_details',{kind:'vehicle',payload:JSON.stringify(body),idempotency_key:key});
    assert.equal(saved.unverified_fields.length,0);
    await assert.rejects(rpc('save_registry_details',{kind:'vehicle',payload:JSON.stringify(body),idempotency_key:crypto.randomUUID()}),/VERSION_CONFLICT/);
    const details={id:customer.id,expectedVersion:1,name:'Source contact',phone:'78901234',document:'',email:'',reason:'Verified contact details'};
    const contactKey=crypto.randomUUID();
    const updated=await rpc<{version:number;phone:string}>('save_registry_details',{kind:'customer',payload:JSON.stringify(details),idempotency_key:contactKey});
    assert.equal(updated.version,2);assert.equal(updated.phone,'78901234');
    assert.deepEqual(await rpc('save_registry_details',{kind:'customer',payload:JSON.stringify(details),idempotency_key:contactKey}),updated);
    const other=await command<{id:string}>('execute_command','create_customer',{name:'Other contact',phone:'',type:'Personal'});
    await assert.rejects(rpc('save_registry_details',{kind:'customer',payload:JSON.stringify({...details,id:other.id}),idempotency_key:crypto.randomUUID()}),/CUSTOMER_MATCH_EXISTS/);
    const alias=await command<{id:string}>('execute_command','create_customer',{name:'Preserved alias',phone:'78909999',type:'Personal'});
    await command('execute_command','merge_customer',{sourceId:alias.id,targetId:customer.id,sourceVersion:1,targetVersion:2,reason:'Same identity verified'});
    await assert.rejects(rpc('save_registry_details',{kind:'customer',payload:JSON.stringify({...details,id:other.id,phone:'78909999'}),idempotency_key:crypto.randomUUID()}),/CUSTOMER_MATCH_EXISTS/);
    await asUser(technician);
    await assert.rejects(rpc('save_registry_details',{kind:'vehicle',payload:JSON.stringify(body),idempotency_key:key}),/PERMISSION_DENIED/);
    await assert.rejects(rpc('save_registry_details',{kind:'customer',payload:JSON.stringify(details),idempotency_key:contactKey}),/PERMISSION_DENIED/);
    assert.ok(customer.id);
  }finally{await db.close();}
});
