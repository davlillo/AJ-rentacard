import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('HU17 departure/return comparison proposes extras without charging and keeps a readiness hold',async()=>{
  const {db,command}=await operationalDb();
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Inspection customer',phone:'78901911',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'INSPECT-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:50,km:100,ownership:'Propio'});
    let booking=await command<{id:string;version:number}>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
      startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:'50',cleaningMinutes:30});
    booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
    const inspection={reservationId:booking.id,expectedVersion:booking.version,km:'100',fuel:'100',condition:'No damage',accessories:'Spare tire',evidence:'Synthetic handover record'};
    const outgoing=await command<{reservation:{id:string;version:number}}>('execute_rental_command','depart',inspection);
    assert.equal((await db.query<{status:string}>('select status from public.vehicles where id=$1',[car.id])).rows[0].status,'Alquilado');
    await assert.rejects(command('execute_rental_command','return',{...inspection,expectedVersion:outgoing.reservation.version,km:'99'}),/ODOMETER_CANNOT_DECREASE/);
    const key=crypto.randomUUID();const returned={...inspection,expectedVersion:outgoing.reservation.version,km:'150',fuel:'70',condition:'New door dent',evidence:'Synthetic return record'};
    const incoming=await command('execute_rental_command','return',returned,key);
    assert.deepEqual(await command('execute_rental_command','return',returned,key),incoming);
    const proposals=(await db.query<{amount:number|null;status:string}>('select amount,status from public.rental_extra_proposals where reservation_id=$1',[booking.id])).rows;
    assert.equal(proposals.length,1);assert.equal(proposals[0].amount,null);assert.equal(proposals[0].status,'Propuesto');
    const vehicle=(await db.query<{status:string;readiness_hold:boolean;km:number}>('select status,readiness_hold,km from public.vehicles where id=$1',[car.id])).rows[0];
    assert.equal(vehicle.status,'En taller');assert.equal(vehicle.readiness_hold,true);assert.equal(vehicle.km,150);
    assert.equal((await db.query('select id from public.rental_inspections')).rows.length,2);
    assert.equal((await db.query('select id from public.expenses')).rows.length,0);
  }finally{await db.close();}
});
