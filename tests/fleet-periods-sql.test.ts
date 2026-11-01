import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';

test('Fleet: managed third-party car, indefinite occupancy and genuinely paid-through periods',async()=>{
  const {db,command,rpc}=await operationalDb();
  try{
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Period acceptance',phone:'78904702',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{
      plate:'PERIOD-CAR',brand:'Test',model:'Managed',year:2026,category:'SUV',color:'White',daily:'40',km:'0',
      ownership:'Cliente',ownerCustomerId:customer.id,inRentalFleet:true,registeredHolder:'Different titleholder'});
    interface Booking {id:string;version:number;ends_at:string;open_ended:boolean;}
    const rental=(action:string,payload:Record<string,unknown>,key?:string)=>command<Booking>('execute_reservation_command',action,payload,key);
    let booking=await rental('create',{vehicleId:car.id,customerId:customer.id,openEnded:true,startsAt:`${today}T00:00:00-06:00`,dailyRate:'40',cleaningMinutes:30});
    assert.equal(booking.ends_at,'infinity');assert.equal(booking.open_ended,true);
    booking=await rental('confirm',{reservationId:booking.id,expectedVersion:booking.version});
    const future=await rental('create',{vehicleId:car.id,customerId:customer.id,
      startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+2*86400000).toISOString(),dailyRate:'40'});
    await assert.rejects(rental('confirm',{reservationId:future.id,expectedVersion:future.version}),/RENTAL_CONFLICT/);
    await rental('evidence',{reservationId:booking.id,body:'CANCELADO HASTA source note is not a cancellation or a receipt'});
    assert.equal(await rpc('rental_paid_through',{reservation_id:booking.id}),null);
    const period=await command<{document_id:string}>('execute_reservation_command','period',{
      reservationId:booking.id,startsOn:today,endsOn:today,date:today,dueOn:today,amount:'40',reason:'Agreed daily period'});
    await assert.rejects(command('execute_reservation_command','period',{
      reservationId:booking.id,startsOn:today,endsOn:today,date:today,dueOn:today,amount:'40',reason:'Duplicate period'}),/exclusion|conflicting/i);
    const payment=await command<{id:string}>('execute_billing_command','pay',{
      customerId:customer.id,amount:'40',date:today,method:'Efectivo',account:'Period cash',reference:'One paid period'});
    assert.equal(await rpc('rental_paid_through',{reservation_id:booking.id}),null);
    await command('execute_billing_command','apply',{paymentId:payment.id,documentId:period.document_id,amount:'40',date:today});
    assert.equal((await rpc<Date>('rental_paid_through',{reservation_id:booking.id})).toISOString().slice(0,10),today);
    const fixed=await rental('set_end',{reservationId:booking.id,expectedVersion:booking.version,
      endsAt:new Date(Date.now()+3*86400000).toISOString(),reason:'Return date now agreed'});
    assert.equal(fixed.open_ended,false);assert.notEqual(fixed.ends_at,'infinity');
    const checklist=(await db.query<{c:number}>('select count(*)::int c from public.vehicle_commitments where reservation_id=$1',[booking.id])).rows[0];
    assert.equal(checklist.c,2);
    await db.exec('reset role');await assert.rejects(db.exec(readFileSync('supabase/rollback/20261030000200_fleet_rental_periods.sql','utf8')),/Rollback refused/);
    await db.exec('rollback');
  }finally{await db.close();}
});
