import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realDataPlan,realDataSql} from '../scripts/import-real-data';
import {operationalDb} from './helpers/operational-db';

test('Real-data import is repeatable, source-verified and creates no invented reception, rental, expense or payment',async()=>{
  const plan=realDataPlan();const {db,owner,rpc}=await operationalDb();
  try{
    for(const book of plan.books)await rpc('stage_source_workbook',{payload:JSON.stringify(book),idempotency_key:crypto.randomUUID()});
    await db.exec('reset role');
    await db.exec(realDataSql(plan,owner));
    assert.equal((await db.query('select id from public.customers')).rows.length,0);
    await db.exec(realDataSql(plan,owner,true));
    await db.exec(realDataSql(plan,owner,true));
    assert.equal((await db.query('select id from public.customers')).rows.length,plan.customers.length);
    assert.equal((await db.query('select id from public.vehicles')).rows.length,28);
    assert.equal((await db.query('select id from public.work_orders')).rows.length,1);
    const quotes=(await db.query<{snapshot:{total:number};source_totals:{balanceNotPosted:number}}>('select snapshot,source_totals from public.estimate_versions')).rows;
    assert.equal(quotes.length,1);assert.equal(quotes[0].snapshot.total,2190);assert.equal(quotes[0].source_totals.balanceNotPosted,1440);
    for(const table of ['reservations','vehicle_commitments','workshop_inspections','expenses','workshop_costs','billing_documents','customer_payments'])
      assert.equal((await db.query('select id from public.'+table)).rows.length,0,table);
    assert.equal((await db.query("select id from public.vehicles where status<>'Por confirmar' or ownership<>'Por confirmar'")).rows.length,0);
    assert.equal((await db.query("select id from public.customers where phone<>''")).rows.length,0);
    assert.equal((await db.query("select id from public.source_workbook_items where status='Publicado'")).rows.length,0);
    assert.equal((await db.query("select id from public.source_workbook_items where status='Vinculado' and record_type='quote'")).rows.length,27);
  }finally{await db.close();}
});
