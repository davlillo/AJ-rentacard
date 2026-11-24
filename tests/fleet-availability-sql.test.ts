import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';

test('Explicit fleet availability preserves unknown mileage/rate and never receives or rents the vehicle',async()=>{
  const {db,command,rpc,asUser,technician}=await operationalDb();
  try{
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'FLEET-READY',brand:'Test',model:'Fleet',year:2026,
      category:'SUV',color:'',daily:0,km:0,ownership:'Por confirmar',inRentalFleet:true,initialStatus:'Disponible',unverifiedFields:['km','daily','color','ownership']});
    const saved=(await db.query<{status:string;unverified_fields:string[]}>('select status,unverified_fields from public.vehicles where id=$1',[car.id])).rows[0];
    assert.equal(saved.status,'Disponible');assert.ok(saved.unverified_fields.includes('km'));assert.ok(saved.unverified_fields.includes('daily'));
    assert.equal((await db.query('select id from public.vehicle_commitments')).rows.length,0);
    assert.equal((await db.query('select id from public.workshop_inspections')).rows.length,0);
    await asUser(technician);
    await assert.rejects(rpc('save_registry_details',{kind:'vehicle',payload:JSON.stringify({id:car.id,expectedVersion:1,status:'Disponible',reason:'Unauthorized'}),idempotency_key:crypto.randomUUID()}),/PERMISSION_DENIED/);
    await db.exec('reset role');
    await db.exec(readFileSync('supabase/rollback/20261101000100_fleet_operational_availability.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261101000100_fleet_operational_availability.sql','utf8'));
  }finally{await db.close();}
});
