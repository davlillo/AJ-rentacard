import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('HU05/HU06 payment imports stage, reconcile and publish once with explicit ambiguity decisions',async()=>{
  const {db,command}=await operationalDb();
  try{
    const date=(await db.query<{d:string}>("select (now() at time zone 'America/El_Salvador')::date::text d")).rows[0].d;
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Payment import customer',phone:'78901966',type:'Personal'});
    const fields={customerId:customer.id,date,amount:'200',method:'Efectivo',account:'Test cashbox',reference:'Imported receipt',sourceKey:'PAY-1'};
    const mapping=Object.fromEntries(Object.keys(fields).map(key=>[key,key]));
    interface Batch{id:string;version:number;status:string;new_total:number;preview:{status:string}[];}
    const run=(name:string,payload:Record<string,unknown>)=>command<Batch>('execute_payment_import',name,payload);
    const staged=await run('stage',{fileName:'payments.csv',base64:Buffer.from('synthetic payment file').toString('base64'),sheet:'Payments',rows:[
      {rowNumber:2,cells:fields,hasFormula:false},{rowNumber:3,cells:{...fields,amount:'bad',sourceKey:'PAY-BAD'},hasFormula:false}]});
    assert.equal((await db.query('select id from public.customer_payments')).rows.length,0);
    let preview=await run('validate',{batchId:staged.id,expectedVersion:staged.version,mapping,sourceSystem:'test-payments',decisions:{}});
    assert.equal(preview.preview[0].status,'Valida');assert.equal(preview.preview[1].status,'Rechazada');
    await assert.rejects(run('commit',{batchId:preview.id,expectedVersion:preview.version,expectedTotal:'200'}),/UNRESOLVED_IMPORT_ROWS/);
    preview=await run('validate',{batchId:preview.id,expectedVersion:preview.version,mapping,sourceSystem:'test-payments',decisions:{'3':{action:'exclude',reason:'Invalid source row reviewed'}}});
    await assert.rejects(run('commit',{batchId:preview.id,expectedVersion:preview.version,expectedTotal:'201'}),/RECONCILIATION_REQUIRED/);
    await run('commit',{batchId:preview.id,expectedVersion:preview.version,expectedTotal:'200'});
    await run('commit',{batchId:preview.id,expectedVersion:preview.version,expectedTotal:'200'});
    assert.equal((await db.query('select id from public.customer_payments')).rows.length,1);
    const repeated=await run('stage',{fileName:'copy.csv',base64:Buffer.from('different artifact same source').toString('base64'),sheet:'Payments',rows:[{rowNumber:2,cells:fields,hasFormula:false}]});
    const duplicate=await run('validate',{batchId:repeated.id,expectedVersion:repeated.version,mapping,sourceSystem:'test-payments',decisions:{}});
    assert.equal(duplicate.preview[0].status,'Duplicada');
    await run('commit',{batchId:duplicate.id,expectedVersion:duplicate.version,expectedTotal:'0'});
    const recap=await run('stage',{fileName:'recap.csv',base64:Buffer.from('recap artifact').toString('base64'),sheet:'Payments',rows:[{rowNumber:2,cells:{...fields,sourceKey:'RECAP-1'},hasFormula:false}]});
    const ambiguous=await run('validate',{batchId:recap.id,expectedVersion:recap.version,mapping,sourceSystem:'test-payments',decisions:{}});
    assert.equal(ambiguous.preview[0].status,'Ambigua');
    const payment=(await db.query<{id:string}>('select id from public.customer_payments')).rows[0];
    const resolved=await run('validate',{batchId:ambiguous.id,expectedVersion:ambiguous.version,mapping,sourceSystem:'test-payments',decisions:{'2':{action:'link',paymentId:payment.id,reason:'Same receipt verified across sources'}}});
    assert.equal(resolved.preview[0].status,'Duplicada');
    await run('commit',{batchId:resolved.id,expectedVersion:resolved.version,expectedTotal:'0'});
    assert.equal((await db.query('select id from public.customer_payments')).rows.length,1);
  }finally{await db.close();}
});
