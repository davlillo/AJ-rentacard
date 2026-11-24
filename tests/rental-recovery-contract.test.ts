import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';
import type {Reservation} from '../src/lib/supabase/reservations';
import type {CaseFile} from '../src/lib/supabase/cases';

test('independent S1/S7: late-return conflict review preserves an independently reserved vehicle',async()=>{
  const {db,command,rpc,owner,asUser}=await operationalDb();
  async function admin(action:()=>Promise<unknown>):Promise<void>{
    await db.exec('reset role');try{await action();}finally{await asUser(owner);}
  }
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Synthetic contract probe',phone:'',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'CONTRACT',brand:'Test',model:'Probe',
      year:2026,category:'Sedán',color:'White',daily:50,km:100,ownership:'Propio'});
    let booking=await command<Reservation>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
      startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:50,cleaningMinutes:30});
    const confirmKey=crypto.randomUUID();const confirmBody={reservationId:booking.id,expectedVersion:booking.version};
    booking=await command('execute_reservation_command','confirm',confirmBody,confirmKey);
    assert.deepEqual(await command('execute_reservation_command','confirm',confirmBody,confirmKey),booking);
    const readings={reservationId:booking.id,km:100,fuel:10,condition:'Recorded',accessories:'None',evidence:'Isolated'};
    booking=(await command<{reservation:Reservation}>('execute_rental_command','depart',{...readings,expectedVersion:booking.version})).reservation;
    await admin(()=>db.query(`update public.vehicle_commitments set ends_at=starts_at+interval '1 microsecond'
      where reservation_id=$1 and kind='Reserva'`,[booking.id]));
    const other=await command<{id:string}>('execute_reservation_command','block',{vehicleId:car.id,kind:'Uso interno',
      startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+600000).toISOString(),reason:'Independent hold'});
    await admin(()=>db.query("update public.vehicle_commitments set kind='Reserva' where id=$1",[other.id]));
    const returned=await command<{cleaningConflict:boolean}>('execute_rental_command','return',{...readings,expectedVersion:booking.version});
    assert.equal(returned.cleaningConflict,true);
    const file=await rpc<CaseFile>('rental_case_file',{reservation_id:booking.id});
    const block=file.commitments.find(commitment=>commitment.kind==='Limpieza')!;
    assert.equal(block.active,false);
    await assert.rejects(command('execute_reservation_command','finish_block',{blockId:block.id,reason:'Cannot bypass'}),
      {message:'BLOCK_CANNOT_BE_FINISHED',code:'P0001'});
    const beforeOther=(await db.query('select * from public.vehicle_commitments where id=$1',[other.id])).rows;
    const saved=await command<{cleaningReviewed:boolean;releaseBlocked:boolean;vehicle:{status:string;readiness_hold:boolean;version:number}}>(
      'execute_reservation_command','review_return_cleaning',{reservationId:booking.id,blockId:block.id,
        expectedVersion:file.reservations[0].version,expectedVehicleVersion:file.vehicle.version,reason:'Cleaning actually performed'});
    assert.equal(saved.cleaningReviewed,true);assert.equal(saved.releaseBlocked,true);
    assert.equal(saved.vehicle.status,file.vehicle.status);assert.equal(saved.vehicle.readiness_hold,true);
    assert.equal(saved.vehicle.version,file.vehicle.version);
    assert.deepEqual((await db.query('select * from public.vehicle_commitments where id=$1',[other.id])).rows,beforeOther);
    assert.equal((await db.query<{n:number}>('select count(*)::int n from public.customer_payments')).rows[0].n,0);
    assert.equal((await db.query<{n:number}>('select count(*)::int n from public.billing_documents')).rows[0].n,0);
  }finally{await db.close();}
});
