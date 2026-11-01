import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';

test('Quote workspace keeps missing source facts unknown and does not receive a vehicle when quoting',async()=>{
  const {db,command,rpc,asUser,technician}=await operationalDb();
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Rafael Vargas',phone:'',type:'Personal'});
    const vehicle=await command<{id:string}>('execute_command','create_vehicle',{
      plate:'',brand:'Nissan',model:'Rogue',year:2018,category:'SUV',color:'',daily:'0',km:'0',ownership:'Por confirmar',inRentalFleet:false});
    await command('execute_command','create_vehicle',{plate:'',brand:'Ford',model:'Plymouth',year:2018,category:'Sedán',color:'Rojo',daily:'0',km:'0',ownership:'Por confirmar',inRentalFleet:false});
    const payload={customerId:customer.id,vehicleId:vehicle.id,service:'Enderezado y pintura',area:'Pintura',parentId:null,reason:'Solicitud de presupuesto',discount:'0',
      lines:[{description:'Reparación',kind:'Trabajo',quantity:'1',unitPrice:'2190',unitCost:null}]};
    const key=crypto.randomUUID();
    const quote=await rpc<{id:string;order_id:string;folio_number:number}>('save_workshop_quote',{payload:JSON.stringify(payload),idempotency_key:key});
    const retry=await rpc<{id:string}>('save_workshop_quote',{payload:JSON.stringify(payload),idempotency_key:key});
    assert.equal(retry.id,quote.id);assert.ok(quote.folio_number>0);
    assert.equal((await db.query<{status:string}>('select status from public.work_orders')).rows[0].status,'Presupuesto');
    assert.equal((await db.query('select id from public.vehicle_commitments')).rows.length,0);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,0);
    await assert.rejects(rpc('deliver_workshop_order',{payload:JSON.stringify({orderId:quote.order_id}),idempotency_key:crypto.randomUUID()}),/ESTIMATE_NOT_RECEIVED/);
    await command('execute_case_command','intake',{orderId:quote.order_id,km:'100',fuel:'50',condition:'Inspección real',accessories:'Llaves'});
    assert.equal((await db.query<{status:string}>('select status from public.work_orders')).rows[0].status,'Diagnóstico');
    assert.equal((await db.query('select id from public.vehicle_commitments')).rows.length,1);
    await asUser(technician);
    await assert.rejects(rpc('save_workshop_quote',{payload:JSON.stringify(payload),idempotency_key:key}),/PERMISSION_DENIED/);
  }finally{await db.close();}
});

test('Usability migration rolls back and reapplies only while its new records are unused',async()=>{
  const {db,command}=await operationalDb();
  try{
    await db.exec('reset role');
    await db.exec(readFileSync('supabase/rollback/20261031000100_usable_quote_workspace.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261031000100_usable_quote_workspace.sql','utf8'));
    await db.exec('set role authenticated');
    await command('execute_command','create_customer',{name:'Rafael Vargas',phone:'',type:'Personal'});
    await db.exec('reset role');
    await assert.rejects(db.exec(readFileSync('supabase/rollback/20261031000100_usable_quote_workspace.sql','utf8')),/Rollback refused/);
    await db.exec('rollback');
  }finally{await db.close();}
});
