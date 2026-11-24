import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';
import {operationMoney} from '../src/controladores/operation-money';
import {rentalWorkflow} from '../src/controladores/rental-workflow';
import type {Reservation,Commitment} from '../src/lib/supabase/reservations';
import type {CaseFile} from '../src/lib/supabase/cases';
import {readFileSync} from 'node:fs';

const conflictReason='CONFLICTO de limpieza tras devolución tardía; requiere reprogramación';
type ReviewResult={reservation:Reservation;vehicle:{id:string;version:number;status:string;readiness_hold:boolean};
  cleaning:Commitment;cleaningReviewed:boolean;releaseBlocked:boolean};
function rollbackSql():string{
  return readFileSync('supabase/rollback/20261114000100_rental_cleaning_recovery.sql','utf8');
}

test('returned cleaning recovery is scoped, versioned, replay-safe and independent of cash',async t=>{
  const context=await operationalDb();const {db,command,rpc,owner,technician,asUser}=context;
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Cleaning recovery fixture',phone:'',type:'Personal'});
    let serial=0;
    async function privileged<T>(action:()=>Promise<T>):Promise<T>{
      await db.exec('reset role');try{return await action();}finally{await asUser(owner);}
    }
    async function fixture(conflict=false){
      const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'CLEAN-'+(++serial),brand:'Test',model:'Recovery',
        year:2026,category:'Sedán',color:'White',daily:50,km:100,ownership:'Propio'});
      let booking=await command<Reservation>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
        startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:50,cleaningMinutes:30});
      booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
      const inspection={reservationId:booking.id,km:100,fuel:90,condition:'No change',accessories:'None',evidence:'Synthetic inspection'};
      booking=(await command<{reservation:Reservation}>('execute_rental_command','depart',{...inspection,expectedVersion:booking.version})).reservation;
      let other:string|undefined;
      if(conflict){
        // Simulate elapsed occupancy only inside this in-memory database to construct an actual return conflict.
        await privileged(()=>db.query(`update public.vehicle_commitments set ends_at=starts_at+interval '1 microsecond'
          where reservation_id=$1 and kind='Reserva'`,[booking.id]));
        other=(await command<{id:string}>('execute_reservation_command','block',{vehicleId:car.id,kind:'Uso interno',
          startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+600000).toISOString(),reason:'Another current use'})).id;
      }
      const returned=await command<{cleaningConflict:boolean}>('execute_rental_command','return',{...inspection,expectedVersion:booking.version});
      assert.equal(returned.cleaningConflict,conflict);
      const file=await rpc<CaseFile>('rental_case_file',{reservation_id:booking.id});
      const block=file.commitments.find(c=>c.kind==='Limpieza')!;
      assert.equal(block.active,!conflict);
      if(conflict)assert.equal(block.reason,conflictReason);
      return{car,booking:file.reservations[0],block,other};
    }
    async function payload(f:Awaited<ReturnType<typeof fixture>>){
      const file=await rpc<CaseFile>('rental_case_file',{reservation_id:f.booking.id});
      return{reservationId:f.booking.id,blockId:f.block.id,expectedVersion:file.reservations[0].version,
        expectedVehicleVersion:file.vehicle.version,reason:'Actual cleaning and readiness reviewed'};
    }
    const review=(body:Record<string,unknown>,key=crypto.randomUUID())=>
      command<ReviewResult>('execute_reservation_command','review_return_cleaning',body,key);
    async function financialSnapshot(){
      return privileged(async()=>JSON.stringify((await db.query(`select jsonb_build_object(
        'documents',(select jsonb_agg(to_jsonb(t) order by id) from public.billing_documents t),
        'payments',(select jsonb_agg(to_jsonb(t) order by id) from public.customer_payments t),
        'applications',(select jsonb_agg(to_jsonb(t) order by id) from public.payment_applications t),
        'expenses',(select jsonb_agg(to_jsonb(t) order by id) from public.expenses t),
        'inspections',(select jsonb_agg(to_jsonb(t) order by id) from public.rental_inspections t)) facts`)).rows[0]));
    }
    await t.test('active cleaning review releases only this vehicle, audits changed rows and preserves debt and inspections',async()=>{
      const f=await fixture();const body=await payload(f);const key=crypto.randomUUID();
      const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
      await command('execute_billing_command','issue',{reservationId:f.booking.id,amount:180,date:today,dueOn:today,description:'Unpaid rental'});
      const before=await financialSnapshot();
      const auditBefore=Number((await db.query<{n:number}>('select count(*)::int n from public.audit_events')).rows[0].n);
      const saved=await review(body,key);
      assert.equal(saved.cleaningReviewed,true);assert.equal(saved.releaseBlocked,false);
      assert.equal(saved.vehicle.status,'Disponible');assert.equal(saved.vehicle.readiness_hold,false);
      assert.equal(saved.vehicle.version,Number(body.expectedVehicleVersion)+1);
      assert.equal(saved.reservation.version,Number(body.expectedVersion)+1);assert.equal(saved.reservation.rental_state,'Devuelto');
      assert.equal(saved.cleaning.active,false);assert.match(saved.cleaning.reason,/Actual cleaning/);
      assert.ok(Date.parse(saved.cleaning.ends_at)>Date.parse(saved.cleaning.starts_at));
      const file=await rpc<CaseFile>('rental_case_file',{reservation_id:f.booking.id});
      assert.equal(operationMoney(file).balance,180);assert.equal(rentalWorkflow(file.reservations[0],file.commitments).step,3);
      assert.equal(file.vehicle.status,'Disponible');assert.equal(file.vehicle.version,saved.vehicle.version);
      assert.equal(file.reservations[0].version,saved.reservation.version);
      assert.equal(await financialSnapshot(),before);
      assert.equal(Number((await db.query<{n:number}>('select count(*)::int n from public.audit_events')).rows[0].n),auditBefore+3);
      const logged=await privileged(()=>db.query<{request:{command:string};result:ReviewResult}>(
        'select request,result from private.command_results where actor=$1 and key=$2',[owner,key]));
      assert.equal(logged.rows[0].request.command,'reservation.review_return_cleaning');
      assert.deepEqual(logged.rows[0].result,saved);
      assert.deepEqual(await review(body,key),saved);
      assert.equal(Number((await db.query<{n:number}>('select count(*)::int n from public.audit_events')).rows[0].n),auditBefore+3);
      assert.equal(await financialSnapshot(),before);
      await assert.rejects(review({...body,reason:'Different request'},key),/IDEMPOTENCY_CONFLICT/);
      await assert.rejects(review({...body,expectedVersion:saved.reservation.version,expectedVehicleVersion:saved.vehicle.version}),/RETURN_CLEANING_NOT_REVIEWABLE/);
      await asUser(technician);await assert.rejects(review(body,key),/PERMISSION_DENIED/);
      await assert.rejects(review(body),/PERMISSION_DENIED/);await asUser(owner);
      await privileged(()=>db.query("delete from public.user_roles where user_id=$1 and role='owner'",[owner]));
      await assert.rejects(review(body,key),/PERMISSION_DENIED/);
      await privileged(()=>db.query("insert into public.user_roles(user_id,role) values($1,'owner')",[owner]));
    });
    await t.test('inactive return conflict can be reviewed without activating an overlapping interval',async()=>{
      const f=await fixture(true);const before=await financialSnapshot();const body=await payload(f);
      const auditBefore=Number((await db.query<{n:number}>('select count(*)::int n from public.audit_events')).rows[0].n);
      const other=(await db.query<Commitment>('select * from public.vehicle_commitments where id=$1',[f.other])).rows[0];
      const saved=await review(body);
      assert.equal(saved.cleaningReviewed,true);assert.equal(saved.releaseBlocked,true);
      assert.equal(saved.vehicle.status,'En taller');assert.equal(saved.vehicle.readiness_hold,true);
      assert.equal(saved.vehicle.version,body.expectedVehicleVersion);assert.equal(saved.reservation.version,Number(body.expectedVersion)+1);
      assert.equal(saved.cleaning.active,false);
      assert.deepEqual((await db.query('select * from public.vehicle_commitments where id=$1',[f.other])).rows[0],other);
      assert.equal(await financialSnapshot(),before);
      assert.equal(Number((await db.query<{n:number}>('select count(*)::int n from public.audit_events')).rows[0].n),auditBefore+2);
      const file=await rpc<CaseFile>('rental_case_file',{reservation_id:f.booking.id});
      assert.equal(rentalWorkflow(file.reservations[0],file.commitments).step,3);
      assert.equal(file.vehicle.status,'En taller');assert.equal(file.vehicle.version,body.expectedVehicleVersion);
      assert.equal((await db.query<{readiness_hold:boolean}>('select readiness_hold from public.vehicles where id=$1',[f.car.id])).rows[0].readiness_hold,true);
    });
    await t.test('inactive conflict releases after the independent blocker has genuinely ended',async()=>{
      const f=await fixture(true);
      await command('execute_reservation_command','finish_block',{blockId:f.other,reason:'Other use ended'});
      const saved=await review(await payload(f));
      assert.equal(saved.releaseBlocked,false);assert.equal(saved.vehicle.status,'Disponible');
    });
    await t.test('both stale and omitted versions reject without any partial cleaning changes',async()=>{
      const f=await fixture();const body=await payload(f);const before=await financialSnapshot();
      for(const change of [{expectedVersion:-1},{expectedVehicleVersion:-1},{expectedVersion:null},{expectedVehicleVersion:null}]){
        await assert.rejects(review({...body,...change}),/VERSION_CONFLICT/);
      }
      const file=await rpc<CaseFile>('rental_case_file',{reservation_id:f.booking.id});
      assert.equal(file.commitments.find(c=>c.id===f.block.id)?.active,true);
      assert.equal(file.reservations[0].version,body.expectedVersion);assert.equal(file.vehicle.version,body.expectedVehicleVersion);
      assert.equal(await financialSnapshot(),before);
    });
    await t.test('unrelated, cancelled, unreturned, future and unknown inactive blocks cannot be reviewed',async()=>{
      const f=await fixture();const other=await fixture();const original=await payload(f);
      await assert.rejects(review({...original,blockId:other.block.id}),/RETURN_CLEANING_NOT_REVIEWABLE/);
      for(const mutation of [
        "update public.reservations set status='Cancelada' where id=$1",
        "update public.reservations set status='Confirmada',rental_state='Entregado' where id=$1",
      ]){
        await privileged(()=>db.query(mutation,[f.booking.id]));
        await assert.rejects(review(original),/RETURN_CLEANING_NOT_REVIEWABLE/);
      }
      await privileged(()=>db.query("update public.reservations set rental_state='Devuelto' where id=$1",[f.booking.id]));
      await privileged(()=>db.query(`update public.vehicle_commitments set starts_at=clock_timestamp()+interval '1 hour',
        ends_at=clock_timestamp()+interval '2 hours' where id=$1`,[f.block.id]));
      await assert.rejects(review(original),/RETURN_CLEANING_NOT_REVIEWABLE/);
      await privileged(()=>db.query(`update public.vehicle_commitments set active=false,reason='Unknown inactive schedule'
        where id=$1`,[f.block.id]));
      await assert.rejects(review(original),/RETURN_CLEANING_NOT_REVIEWABLE/);
      const g=await fixture();
      await assert.rejects(review({...await payload(g),reason:'   '}),/RETURN_CLEANING_REVIEW_REASON_REQUIRED/);
      await assert.rejects(review({...await payload(g),reason:'x'.repeat(4001)}),/RETURN_CLEANING_REVIEW_REASON_REQUIRED/);
      await privileged(()=>db.query(`update public.vehicle_commitments set active=false,reason='Previously reviewed' where id=$1`,[g.block.id]));
      await assert.rejects(review(await payload(g)),/RETURN_CLEANING_NOT_REVIEWABLE/);
    });
    await t.test('a reservation state without immutable return evidence cannot be reviewed',async()=>{
      const f=await fixture();
      const draft=await command<Reservation>('execute_reservation_command','create',{vehicleId:f.car.id,customerId:customer.id,
        startsAt:new Date(Date.now()-7200000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:50});
      await privileged(async()=>{
        await db.query("update public.reservations set status='Confirmada',rental_state='Devuelto' where id=$1",[draft.id]);
        await db.query('update public.vehicle_commitments set reservation_id=$1 where id=$2',[draft.id,f.block.id]);
      });
      await assert.rejects(review({reservationId:draft.id,blockId:f.block.id,expectedVersion:draft.version,
        expectedVehicleVersion:(await payload(f)).expectedVehicleVersion,reason:'No return inspection'}),/RETURN_CLEANING_NOT_REVIEWABLE/);
    });
    await t.test('wrong kind, linked workshop and a conflict predating the return remain ineligible',async()=>{
      const f=await fixture();
      await privileged(()=>db.query("update public.vehicle_commitments set kind='Taller' where id=$1",[f.block.id]));
      await assert.rejects(review(await payload(f)),/RETURN_CLEANING_NOT_REVIEWABLE/);
      await privileged(()=>db.query("update public.vehicle_commitments set kind='Limpieza' where id=$1",[f.block.id]));
      const order=await privileged(async()=>{
        const created=await db.query<{id:string}>(`insert into public.work_orders(vehicle_id,customer_id,area,service,due,occurred_at,created_by)
          values($1,$2,'Mecánica','Linked workshop',current_date,clock_timestamp()+interval '2 hours',$3) returning id`,[f.car.id,customer.id,owner]);
        const id=created.rows[0].id;
        await db.query('update public.vehicle_commitments set order_id=null where order_id=$1',[id]);
        await db.query('update public.vehicle_commitments set order_id=$1 where id=$2',[id,f.block.id]);
        return id;
      });
      assert.ok(order);
      await assert.rejects(review(await payload(f)),/RETURN_CLEANING_NOT_REVIEWABLE/);
      const g=await fixture();
      await privileged(()=>db.query(`update public.vehicle_commitments set active=false,reason=$1,
        starts_at=$2::timestamptz-interval '1 second' where id=$3`,[conflictReason,g.booking.actual_return_at,g.block.id]));
      await assert.rejects(review(await payload(g)),/RETURN_CLEANING_NOT_REVIEWABLE/);
    });
    await t.test('another current reservation remains a release blocker, including Reserva commitments',async()=>{
      const f=await fixture(true);
      await privileged(()=>db.query("update public.vehicle_commitments set kind='Reserva' where id=$1",[f.other]));
      const saved=await review(await payload(f));
      assert.equal(saved.releaseBlocked,true);assert.equal(saved.vehicle.readiness_hold,true);
      assert.equal((await db.query<Commitment>('select * from public.vehicle_commitments where id=$1',[f.other])).rows[0].active,true);
    });
    await t.test('an open workshop order blocks release even when its commitment starts in the future',async()=>{
      const f=await fixture();
      await privileged(()=>db.query(`insert into public.work_orders(vehicle_id,customer_id,area,service,due,occurred_at,created_by)
        values($1,$2,'Mecánica','Other workshop work',current_date,clock_timestamp()+interval '2 hours',$3)`,[f.car.id,customer.id,owner]));
      const saved=await review(await payload(f));
      assert.equal(saved.releaseBlocked,true);assert.equal(saved.vehicle.status,'En taller');assert.equal(saved.vehicle.readiness_hold,true);
    });
    await t.test('another delivered rental retains its status and hold while cleaning review succeeds',async()=>{
      const f=await fixture();
      const next=await command<Reservation>('execute_reservation_command','create',{vehicleId:f.car.id,customerId:customer.id,
        startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:50});
      await privileged(async()=>{
        await db.query("update public.reservations set status='Confirmada',rental_state='Entregado' where id=$1",[next.id]);
        await db.query("update public.vehicles set status='Alquilado',version=version+1 where id=$1",[f.car.id]);
      });
      const body=await payload(f);const saved=await review(body);
      assert.equal(saved.releaseBlocked,true);assert.equal(saved.vehicle.status,'Alquilado');
      assert.equal(saved.vehicle.version,body.expectedVehicleVersion);assert.equal(saved.vehicle.readiness_hold,true);
    });
    await t.test('older returned folios cannot release the latest return hold',async()=>{
      const f=await fixture();
      const next=await command<Reservation>('execute_reservation_command','create',{vehicleId:f.car.id,customerId:customer.id,
        startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:50});
      await privileged(async()=>{
        await db.query("update public.reservations set status='Confirmada',rental_state='Devuelto' where id=$1",[next.id]);
        await db.query(`insert into public.rental_inspections(reservation_id,kind,km,fuel,condition,accessories,evidence,created_by)
          values($1,'Retorno',100,90,'Later return','None','Later immutable return',$2)`,[next.id,owner]);
      });
      await assert.rejects(review(await payload(f)),/RETURN_CLEANING_NOT_REVIEWABLE/);
    });
    await t.test('legacy finish_block keeps its unrelated-kind and inactive guards unchanged',async()=>{
      const f=await fixture(true);
      await assert.rejects(command('execute_reservation_command','finish_block',{blockId:f.block.id,reason:'Still inactive'}),/BLOCK_CANNOT_BE_FINISHED/);
      const key=crypto.randomUUID();const body={blockId:f.other,reason:'Internal use genuinely completed'};
      const saved=await command('execute_reservation_command','finish_block',body,key);
      assert.deepEqual(await command('execute_reservation_command','finish_block',body,key),saved);
      assert.equal((await rpc<CaseFile>('rental_case_file',{reservation_id:f.booking.id})).vehicle.status,'En taller');
    });
    await t.test('private delegation is not executable by browser roles and anonymous callers cannot review',async()=>{
      const privileges=await privileged(()=>db.query<{private_execute:boolean;public_execute:boolean}>(`select
        has_function_privilege('authenticated','private.reservation_command_before_cleaning_review(text,jsonb,uuid)','EXECUTE') private_execute,
        has_function_privilege('anon','public.execute_reservation_command(text,jsonb,uuid)','EXECUTE') public_execute`));
      assert.equal(privileges.rows[0].private_execute,false);assert.equal(privileges.rows[0].public_execute,false);
      await db.exec('reset role;set role anon');
      await assert.rejects(review({}),/permission denied|PERMISSION_DENIED/);
      await asUser(owner);
    });
    await t.test('rollback refuses to remove recovery after a recorded cleaning review',async()=>{
      await privileged(async()=>{
        try{await assert.rejects(db.exec(rollbackSql()),/CLEANING_RECOVERY_ALREADY_USED/);}
        finally{await db.exec('rollback');}
      });
    });
  }finally{await db.close();}
});

test('unused recovery migration has an executable guarded rollback equivalent',async()=>{
  const {db}=await operationalDb();
  try{
    await db.exec('reset role');await db.exec(rollbackSql());
    const definition=(await db.query<{definition:string}>("select pg_get_functiondef('public.execute_reservation_command(text,jsonb,uuid)'::regprocedure) definition")).rows[0].definition;
    assert.match(definition,/reservation_command_before_fit/);
    assert.doesNotMatch(definition,/review_return_cleaning/);
  }finally{await db.close();}
});
