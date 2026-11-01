import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('Renamed delivery checklist does not retain a qualifier that fails in a fresh PostgreSQL API session',async()=>{
  const {db}=await operationalDb();
  try{
    await db.exec('reset role');
    const source=(await db.query<{source:string}>("select prosrc source from pg_proc where oid='private.delivery_checklist_before_cases(text)'::regprocedure")).rows[0].source;
    assert.ok(!source.includes('delivery_checklist.order_id'));assert.ok(source.includes('d.order_id=$1'));
  }finally{await db.close();}
});
