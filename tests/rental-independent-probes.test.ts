import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';
import {startInspection,confirmInspection,inspectionBaseline} from '../src/controladores/rental-inspection-flow';
import {rentalExtensionPreview} from '../src/controladores/rental-extension-preview';
import type {Reservation} from '../src/lib/supabase/reservations';
import type {CaseFile} from '../src/lib/supabase/cases';

interface CleaningReview {
  cleaningReviewed:boolean;releaseBlocked:boolean;
  vehicle:{status:string;readiness_hold:boolean;version:number};
}
const rollbackSql=()=>readFileSync('supabase/rollback/20261114000100_rental_cleaning_recovery.sql','utf8');

test('independent S2/S3/S6: captured intent, fresh return, unknown readings and forecast boundaries',()=>{
  const booking={id:'fixture',version:4,status:'Confirmada',rental_state:'Preparado',folio_number:1,
    customer_snapshot:{name:'Synthetic fixture'},vehicle_snapshot:{km:null,unverified_fields:['km']},
    starts_at:'2026-11-10T00:00:00Z',ends_at:'2026-11-12T00:00:00Z',total:100,daily_rate:50} as unknown as Reservation;
  const draft={...startInspection(booking,'departure'),km:'0',fuel:'100',review:'Recorded'};
  const confirmation=confirmInspection(draft,null);
  booking.rental_state='Entregado';booking.version=5;
  assert.equal(confirmation.command,'depart');assert.equal(confirmation.payload.expectedVersion,4);
  const incoming=startInspection(booking,'return');
  assert.deepEqual([incoming.km,incoming.fuel,incoming.review],['','','']);
  assert.equal(inspectionBaseline(booking,[]),null);
  for(const fuel of ['-0.01','100.01','1.001',''])assert.throws(()=>confirmInspection({...draft,fuel},null));
  for(const km of ['-1','2147483648','1.1',''])assert.throws(()=>confirmInspection({...draft,km},null));
  const frozen=JSON.stringify(booking);
  const preview=rentalExtensionPreview(booking,'2026-11-12T03:00:00Z','Extra time');
  assert.equal(preview.newForecast,150);assert.equal(preview.difference,50);assert.equal(JSON.stringify(booking),frozen);
  assert.deepEqual(Object.keys(preview.payload).sort(),['endsAt','expectedVersion','reason','reservationId']);
});

test('independent S1/S4/S7: rejected state hashes, queued competing reviews, actor replay and used rollback',async()=>{
  const {db,command,rpc,asUser,owner,technician}=await operationalDb();
  async function admin<T>(action:()=>Promise<T>):Promise<T>{
    await db.exec('reset role');try{return await action();}finally{await asUser(owner);}
  }
  async function hash():Promise<string>{
    return admin(async()=>{
      const rows=await db.query(`select jsonb_build_object(
        'cars',(select jsonb_agg(to_jsonb(x) order by id) from public.vehicles x),
        'bookings',(select jsonb_agg(to_jsonb(x) order by id) from public.reservations x),
        'blocks',(select jsonb_agg(to_jsonb(x) order by id) from public.vehicle_commitments x),
        'inspections',(select jsonb_agg(to_jsonb(x) order by id) from public.rental_inspections x),
        'commands',(select jsonb_agg(to_jsonb(x) order by actor,key) from private.command_results x),
        'audit',(select jsonb_agg(to_jsonb(x) order by id) from public.audit_events x),
        'cash',(select jsonb_agg(to_jsonb(x) order by id) from public.customer_payments x),
        'charges',(select jsonb_agg(to_jsonb(x) order by id) from public.billing_documents x)) snapshot`);
      return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex');
    });
  }
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Synthetic independent probe',phone:'',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'INDEPENDENT',brand:'Test',model:'Probe',
      year:2026,category:'Sedán',color:'White',daily:50,km:100,ownership:'Propio'});
    let booking=await command<Reservation>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
      startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:50,cleaningMinutes:0});
    booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
    const readings={reservationId:booking.id,km:100,fuel:0,condition:'Recorded',accessories:'None',evidence:'Isolated'};
    const departure=await command<{reservation:Reservation}>('execute_rental_command','depart',{...readings,expectedVersion:booking.version});
    const beforeStale=await hash();
    await assert.rejects(command('execute_rental_command','depart',{...readings,expectedVersion:booking.version}),
      {message:'VERSION_CONFLICT',code:'23505'});
    assert.equal(await hash(),beforeStale);
    await command('execute_rental_command','return',{...readings,expectedVersion:departure.reservation.version});
    const file=await rpc<CaseFile>('rental_case_file',{reservation_id:booking.id});
    const body={reservationId:booking.id,blockId:file.commitments.find(block=>block.kind==='Limpieza')!.id,
      expectedVersion:file.reservations[0].version,expectedVehicleVersion:file.vehicle.version,reason:'Performed and checked'};
    const review=(payload:unknown,key=crypto.randomUUID())=>rpc<CleaningReview>('execute_reservation_command',{
      command:'review_return_cleaning',payload:JSON.stringify(payload),idempotency_key:key});
    const negatives:[unknown,string,string][]=[
      [{...body,blockId:crypto.randomUUID()},'RETURN_CLEANING_NOT_REVIEWABLE','P0001'],
      [{...body,expectedVersion:undefined},'VERSION_CONFLICT','P0001'],
      [{...body,expectedVehicleVersion:undefined},'VEHICLE_VERSION_CONFLICT','P0001'],
      [{...body,expectedVersion:'wrong'},'invalid input syntax for type integer: "wrong"','22P02'],
      [{...body,reason:' '.repeat(5)},'RETURN_CLEANING_REVIEW_REASON_REQUIRED','P0001'],
      [[], 'INVALID_REQUEST','P0001'],
    ];
    for(const [payload,message,code] of negatives){
      const before=await hash();await assert.rejects(review(payload),{message,code});assert.equal(await hash(),before);
    }
    const key=crypto.randomUUID();
    // PGlite queues these requests on one connection; this is not a real multi-session lock proof.
    const competing=await Promise.allSettled([review(body,key),review(body)]);
    assert.deepEqual(competing.map(result=>result.status),['fulfilled','rejected']);
    assert.ok(competing[0].status==='fulfilled');assert.ok(competing[1].status==='rejected');
    assert.equal(competing[1].reason.message,'VERSION_CONFLICT');
    const saved=competing[0].value;
    assert.equal(saved.cleaningReviewed,true);assert.equal(saved.releaseBlocked,false);
    assert.equal(saved.vehicle.status,'Disponible');assert.equal(saved.vehicle.readiness_hold,false);
    const after=await hash();assert.deepEqual(await review(body,key),saved);assert.equal(await hash(),after);
    await assert.rejects(review({...body,reason:'Altered'},key),{message:'IDEMPOTENCY_CONFLICT',code:'P0001'});
    assert.equal(await hash(),after);
    await asUser(technician);await assert.rejects(review(body,key),{message:'PERMISSION_DENIED',code:'42501'});await asUser(owner);
    assert.equal(await hash(),after);
    await admin(()=>db.query("insert into public.user_roles(user_id,role) values($1,'owner')",[technician]));
    await asUser(technician);
    await assert.rejects(review(body,key),{message:'VERSION_CONFLICT',code:'P0001'});await asUser(owner);
    await admin(()=>db.query("delete from public.user_roles where user_id=$1 and role='owner'",[technician]));
    await asUser(technician);await assert.rejects(review(body,key),{message:'PERMISSION_DENIED',code:'42501'});await asUser(owner);
    const beforeRollback=await hash();
    await admin(async()=>{
      try{await assert.rejects(db.exec(rollbackSql()),{message:'CLEANING_RECOVERY_ALREADY_USED',code:'P0001'});}
      finally{await db.exec('rollback');}
    });
    assert.equal(await hash(),beforeRollback);assert.deepEqual(await review(body,key),saved);
  }finally{await db.close();}
});

test('independent S1: unused rollback removes its alias, restores grants and permits reapplication',async()=>{
  const {db}=await operationalDb();
  try{
    await db.exec('reset role');await db.exec(rollbackSql());
    const result=(await db.query<{definition:string;alias:string|null;anon_execute:boolean;auth_execute:boolean}>(`select
      pg_get_functiondef('public.execute_reservation_command(text,jsonb,uuid)'::regprocedure) definition,
      to_regprocedure('private.reservation_command_before_cleaning_review(text,jsonb,uuid)')::text alias,
      has_function_privilege('anon','public.execute_reservation_command(text,jsonb,uuid)','execute') anon_execute,
      has_function_privilege('authenticated','public.execute_reservation_command(text,jsonb,uuid)','execute') auth_execute`)).rows[0];
    assert.match(result.definition,/reservation_command_before_fit/);assert.doesNotMatch(result.definition,/review_return_cleaning/);
    assert.equal(result.alias,null);assert.equal(result.anon_execute,false);assert.equal(result.auth_execute,true);
    await db.exec(readFileSync('supabase/migrations/20261114000100_rental_cleaning_recovery.sql','utf8'));
    const reapplied=(await db.query<{alias:string|null;definition:string}>(`select
      to_regprocedure('private.reservation_command_before_cleaning_review(text,jsonb,uuid)')::text alias,
      pg_get_functiondef('public.execute_reservation_command(text,jsonb,uuid)'::regprocedure) definition`)).rows[0];
    assert.ok(reapplied.alias);assert.match(reapplied.definition,/review_return_cleaning/);
  }finally{await db.close();}
});
