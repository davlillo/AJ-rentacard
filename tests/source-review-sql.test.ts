import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('Original workbook staging is private and repeatable; reviewed publication reconciles and checks similar facts',async()=>{
  const {db,rpc,command,asUser,owner,technician}=await operationalDb();
  try{
    const payload={fileName:'source.xlsx',base64:Buffer.from('PK original source bytes').toString('base64'),format:'diary',parserVersion:'test-v1',sheets:[],items:[]};
    const staged={...payload,sheets:[{name:'Sheet1',range:'A1:B2',rows:[],merges:[]}],items:[
      {sourceRef:'Sheet1!A1:B1',row:1,category:'Diario',title:'One physical expense'},
      {sourceRef:'Sheet1!A2:B2',row:2,category:'Control',title:'Subtotal'}]};
    const args={payload:JSON.stringify(staged),idempotency_key:crypto.randomUUID()};
    const book=await rpc<{id:string}>('stage_source_workbook',args);
    assert.equal((await rpc<{id:string}>('stage_source_workbook',{...args,idempotency_key:crypto.randomUUID()})).id,book.id);
    const bundle=await rpc<{items:{id:string;version:number}[]}>('source_workbook_bundle',{workbook_id:book.id});
    const proposed={date:'2026-05-02',amount:'15',concept:'Airport parking',category:'Airport',method:'Efectivo',account:'Cash',costCenterId:'rental'};
    const review={itemId:bundle.items[0].id,expectedVersion:1,action:'publish',recordType:'expense',reason:'Verified original receipt',proposal:proposed,expectedAmount:'16'};
    await assert.rejects(rpc('review_source_item',{payload:JSON.stringify(review),idempotency_key:crypto.randomUUID()}),/SOURCE_RECONCILIATION_MISMATCH/);
    assert.equal((await db.query('select id from public.expenses')).rows.length,0);
    await command('execute_command','record_expense',proposed);
    await assert.rejects(rpc('review_source_item',{payload:JSON.stringify({...review,expectedAmount:'15'}),idempotency_key:crypto.randomUUID()}),/SOURCE_SIMILAR_RECORDS_REQUIRE_REVIEW/);
    const expense=(await db.query<{id:string}>('select id from public.expenses')).rows[0];
    await rpc('review_source_item',{payload:JSON.stringify({...review,action:'link',proposal:null,recordId:expense.id}),idempotency_key:crypto.randomUUID()});
    assert.equal((await db.query('select id from public.expenses')).rows.length,1);
    await assert.rejects(rpc('review_source_item',{payload:JSON.stringify({...review,itemId:bundle.items[1].id,expectedAmount:'15',distinctConfirmed:true}),idempotency_key:crypto.randomUUID()}),/SOURCE_NOT_PUBLISHABLE/);
    await asUser(technician);await assert.rejects(rpc('source_workbook_bundle',{workbook_id:book.id}),/PERMISSION_DENIED/);
    await asUser(owner);
  }finally{await db.close();}
});
