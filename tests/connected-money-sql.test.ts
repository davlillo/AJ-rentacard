import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';
import {operationMoney} from '../src/controladores/operation-money';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {CashDiary} from '../src/lib/supabase/diary';

test('Connected money: one cash event can be captured anywhere, split, traced and collected without double posting',async t=>{
  const {db,command,rpc,asUser,owner,technician}=await operationalDb();
  try{
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Connected money',phone:'',type:'Personal'});
    const jobs:{id:string;vehicleId:string}[]=[];
    for(let index=0;index<3;index++){
      const car=await command<{id:string}>('execute_command','create_vehicle',{plate:`LINK-${index}`,brand:'Test',model:'Car',year:2026,
        category:'SUV',color:'White',daily:0,km:100,ownership:'Cliente',ownerCustomerId:customer.id,inRentalFleet:false});
      const job=await command<{id:string}>('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Pintura',service:'Linked work'});
      jobs.push({id:job.id,vehicleId:car.id});
    }
    const expensePayload={date,concept:'One payment for three jobs',amount:'180',category:'Labor',method:'Efectivo',account:'Linked cash',costCenterId:'workshop'};
    const expense=await command<{id:string}>('execute_command','record_expense',expensePayload);
    const original=(await db.query('select * from public.expenses where id=$1',[expense.id])).rows[0];
    const link={expenseId:expense.id,reason:'Reviewed split from original receipt',allocations:jobs.map((job,index)=>({orderId:job.id,amount:['75','100','5'][index]}))};
    const money=<T=Record<string,unknown>>(name:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>rpc<T>(name,{payload:JSON.stringify(payload),idempotency_key:key});
    await t.test('an existing diary expense links to three folios, retaining one immutable cash source',async()=>{
      assert.equal((await rpc<unknown[]>('workshop_expense_inbox',{})).length,1);
      await assert.rejects(money('link_workshop_expense',{...link,allocations:[{orderId:jobs[0].id,amount:'179'}]}),/EXPENSE_ALLOCATION_TOTAL_MISMATCH/);
      const key=crypto.randomUUID();const saved=await money('link_workshop_expense',link,key);
      assert.deepEqual(await money('link_workshop_expense',link,key),saved);
      await assert.rejects(money('link_workshop_expense',link),/EXPENSE_ALREADY_LINKED/);
      assert.deepEqual((await db.query('select * from public.expenses where id=$1',[expense.id])).rows[0],original);
      assert.equal((await rpc<unknown[]>('workshop_expense_inbox',{})).length,0);
      for(const [index,job] of jobs.entries()){
        const file=await rpc<CaseFile>('vehicle_case_file',{vehicle_id:job.vehicleId,order_id:job.id});
        const summary=operationMoney(file,job.id);
        assert.equal(summary.costs,[75,100,5][index]);assert.equal(summary.cashOut,summary.costs);
        assert.equal(summary.charged,0);assert.equal(file.expenses?.[0].amount,180);assert.equal(file.expenses?.[0].shared,true);
      }
      const diary=await rpc<CashDiary>('cash_diary',{from_date:date,to_date:date});
      assert.equal(diary.outgoing,180);assert.equal(diary.rows.length,1);assert.equal(diary.rows[0].links?.length,3);
    });
    await t.test('capture from a folio atomically stores one expense and its link; an invalid split stores nothing',async()=>{
      const payload={...expensePayload,concept:'Captured in folio',amount:'20',reason:'One job',allocations:[{orderId:jobs[0].id,amount:'20'}]};
      const key=crypto.randomUUID();const saved=await money('record_linked_expense',payload,key);
      assert.deepEqual(await money('record_linked_expense',payload,key),saved);
      await assert.rejects(money('record_linked_expense',{...payload,amount:'21'}),/EXPENSE_ALLOCATION_TOTAL_MISMATCH/);
      assert.equal((await db.query('select id from public.expenses')).rows.length,2);
      assert.equal((await rpc<CashDiary>('cash_diary',{from_date:date,to_date:date})).outgoing,200);
    });
    await t.test('an advance is visible in its folio before a charge; applying it later creates no new cash',async()=>{
      const payload={customerId:customer.id,orderId:jobs[0].id,amount:'200',date,method:'Efectivo',account:'Linked cash',reference:'Advance in folio'};
      const key=crypto.randomUUID();const saved=await money<{receipt:{id:string}}>('record_linked_receipt',payload,key);
      assert.deepEqual(await money('record_linked_receipt',payload,key),saved);
      let file=await rpc<CaseFile>('vehicle_case_file',{vehicle_id:jobs[0].vehicleId,order_id:jobs[0].id});
      assert.equal(file.advances?.[0].available_amount,200);assert.equal(operationMoney(file,jobs[0].id).balance,0);
      const quote=await command<{id:string}>('execute_case_command','quote',{orderId:jobs[0].id,parentId:null,reason:'Complete scope',
        lines:[{description:'Work',kind:'Trabajo',quantity:'1',unitPrice:'500',unitCost:null}]});
      await command('execute_estimate_command','approve',{estimateId:quote.id,approverName:'Test customer',evidence:'Test authorization'});
      const charge=await command<{id:string}>('execute_case_command','bill_scope',{orderId:jobs[0].id,date,dueOn:date});
      await money('record_linked_receipt',{customerId:customer.id,orderId:jobs[0].id,documentId:charge.id,paymentId:saved.receipt.id,amount:'100',date});
      file=await rpc<CaseFile>('vehicle_case_file',{vehicle_id:jobs[0].vehicleId,order_id:jobs[0].id});
      assert.equal(file.advances?.[0].available_amount,100);assert.equal(operationMoney(file,jobs[0].id).balance,400);
      assert.equal(operationMoney(file,jobs[0].id).collectionState,'Pago parcial');
      const diary=await rpc<CashDiary>('cash_diary',{from_date:date,to_date:date});
      assert.equal(diary.income,200);assert.equal(diary.rows.filter(row=>row.source_type==='receipt').length,1);
      assert.equal(diary.rows.find(row=>row.source_type==='receipt')?.unapplied_amount,100);
      assert.equal((await db.query('select id from public.customer_payments')).rows.length,1);
      const other=await command<{id:string}>('execute_command','create_customer',{name:'Different customer',phone:'',type:'Personal'});
      await assert.rejects(money('record_linked_receipt',{...payload,customerId:other.id,documentId:charge.id}),/PAYMENT_CUSTOMER_MISMATCH/);
      assert.equal((await db.query('select id from public.customer_payments')).rows.length,1);
    });
    await t.test('an existing cost becomes a traceable budget line without another expense or automatic debt',async()=>{
      const costs=(await db.query<{id:string;version:number}>('select id,version from public.workshop_costs where linked_expense_id=$1 and order_id=$2',[expense.id,jobs[0].id])).rows[0];
      const parent=(await db.query<{id:string}>('select id from public.estimate_versions where order_id=$1 order by revision desc limit 1',[jobs[0].id])).rows[0];
      const payload={orderId:jobs[0].id,parentId:parent.id,reason:'Additional scope linked to actual cost',lines:[
        {description:'Original work',kind:'Trabajo',quantity:'1',unitPrice:'500',unitCost:null},
        {description:'Reviewed extra',kind:'Indirecto',quantity:'1',unitPrice:'90',unitCost:'75',sourceCostId:costs.id,sourceCostVersion:costs.version}]};
      const key=crypto.randomUUID();const saved=await money<{id:string;snapshot:{total:number}}>('record_connected_quote',payload,key);
      assert.equal(saved.snapshot.total,590);assert.deepEqual(await money('record_connected_quote',payload,key),saved);
      const file=await rpc<CaseFile>('vehicle_case_file',{vehicle_id:jobs[0].vehicleId,order_id:jobs[0].id});
      assert.equal(file.allocations?.find(a=>a.cost_id===costs.id)?.estimate_id,saved.id);
      assert.equal(file.allocations?.find(a=>a.cost_id===costs.id)?.line_index,1);
      assert.equal(operationMoney(file,jobs[0].id).charged,500);assert.equal(operationMoney(file,jobs[0].id).costs,95);
      assert.equal((await db.query('select id from public.expenses')).rows.length,2);
    });
    await t.test('financial reads and linking enforce server permissions',async()=>{
      await asUser(technician);
      await assert.rejects(rpc('workshop_expense_inbox',{}),/PERMISSION_DENIED/);
      await assert.rejects(money('link_workshop_expense',link),/PERMISSION_DENIED/);
      await assert.rejects(rpc('vehicle_case_file',{vehicle_id:jobs[0].vehicleId,order_id:jobs[0].id}),/PERMISSION_DENIED/);
      await asUser(owner);
      await db.exec('reset role');
      await assert.rejects(db.exec(readFileSync('supabase/rollback/20261102000100_connected_money.sql','utf8')),/Rollback refused/);
    });
  }finally{await db.close();}
});

test('Connected money migration rolls back and reapplies before its records are used',async()=>{
  const {db}=await operationalDb();
  try{
    await db.exec('reset role');
    await db.exec(readFileSync('supabase/rollback/20261102000100_connected_money.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261102000100_connected_money.sql','utf8'));
  }finally{await db.close();}
});
