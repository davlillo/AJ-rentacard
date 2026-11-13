import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diaryNewestFirst} from '../src/controladores/diary-order';
import type {DiaryRow} from '../src/lib/supabase/diary';

const row=(id:string,date:string,created_at?:string):DiaryRow=>({id,date,created_at,kind:'Egreso',concept:id,amount:1,
  account:'Cash',counter_account:null,area:'Taller',destination:'workshop',source_type:'expense',inflow:0,outflow:1,balance_effect:-1});
test('Diary keeps effective days descending and newly recorded events first within a day',()=>{
  const entries=[row('expense:EG-9','2026-11-09','2026-11-09T08:00:00Z'),row('receipt:z','2026-11-09','2026-11-09T07:00:00Z'),
    row('expense:EG-10','2026-11-09','2026-11-09T09:00:00Z'),row('expense:EG-11','2026-11-08','2026-11-10T09:00:00Z')];
  assert.deepEqual(entries.sort(diaryNewestFirst).map(entry=>entry.id),['expense:EG-10','expense:EG-9','receipt:z','expense:EG-11']);
  assert.ok(diaryNewestFirst(row('expense:EG-10','2026-11-09'),row('expense:EG-9','2026-11-09'))<0);
});
