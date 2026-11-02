import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';

test('HU13-HU30 empty-module rollback/reapply refuses any used module',async()=>{
  const {db,command}=await operationalDb();
  try{
    await db.exec('reset role');const rollback=readFileSync('supabase/rollback/20261022001000_to_002000_operations.sql','utf8');
    await db.exec(readFileSync('supabase/rollback/20261102000100_connected_money.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261101000100_fleet_operational_availability.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261031000400_unknown_vehicle_registration.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261031000300_registry_alias_integrity.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261031000200_complete_verified_details.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261031000100_usable_quote_workspace.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030001000_command_replay_permissions.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000900_internal_cost_only_estimates.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000800_rental_case_file.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000700_renamed_checklist_scope.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000600_case_integration_guards.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000500_reviewed_source_workbooks.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000400_cash_diary.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000300_grouped_billing.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000200_fleet_rental_periods.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261030000100_vehicle_case_files.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261022002100_review_integrity.sql','utf8'));
    await db.exec(rollback);
    assert.equal((await db.query<{name:string|null}>("select to_regclass('public.reservations')::text name")).rows[0].name,null);
    for(const file of readdirSync('supabase/migrations').filter(file=>file>='20261022001000'&&file.endsWith('.sql')).sort())await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'));
    await db.exec('set role authenticated');
    await command('execute_inventory_command','item',{sku:'ROLLBACK-REFUSAL',name:'Preserve operational data',unit:'unit'});
    await command('execute_optional_command','budget',{name:'Preserve used review workflows',area:'Taller',category:'Materials',
      startsOn:'2026-01-01',endsOn:'2026-12-31',authorized:'100'});
    await db.exec('reset role');
    await assert.rejects(db.exec(readFileSync('supabase/rollback/20261022002100_review_integrity.sql','utf8')),/Rollback refused/);
    await db.exec('rollback');
    await db.exec('reset role');await assert.rejects(db.exec(rollback),/Rollback refused/);await db.exec('rollback');
    assert.equal((await db.query('select id from public.stock_items')).rows.length,1);
  }finally{await db.close();}
});
