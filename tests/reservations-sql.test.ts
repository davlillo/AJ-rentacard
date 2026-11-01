import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('HU13-HU16 authoritative rental calendar, evidence and conflict-aware extensions',async t=>{
  const {db,owner,technician,asUser,rpc,command}=await operationalDb();
  interface Booking{id:string;version:number;status:string;total:number;}
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Calendar customer',phone:'78901888',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'CAL-1',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    const other=await command<{id:string}>('execute_command','create_vehicle',{plate:'CAL-2',brand:'Test',model:'Other',year:2026,category:'Sedán',color:'White',daily:50,km:0,ownership:'Propio'});
    const payload={vehicleId:car.id,customerId:customer.id,startsAt:'2030-01-01T12:00:00Z',endsAt:'2030-01-03T12:00:00Z',dailyRate:'50',cleaningMinutes:60};
    const book=(name:string,p:Record<string,unknown>,key=crypto.randomUUID())=>command<Booking>('execute_reservation_command',name,p,key);
    let first:Booking;let next:Booking;
    await t.test('drafts do not occupy; only one conflicting confirmation can succeed; cleaning also blocks',async()=>{
      first=await book('create',payload);const competitor=await book('create',payload);
      assert.equal((await db.query('select id from public.vehicle_commitments')).rows.length,0);
      first=await book('confirm',{reservationId:first.id,expectedVersion:first.version});
      await assert.rejects(book('confirm',{reservationId:competitor.id,expectedVersion:competitor.version}),/RENTAL_CONFLICT/);
      assert.equal((await db.query('select id from public.vehicle_commitments where reservation_id=$1',[first.id])).rows.length,2);
      next=await book('create',{...payload,startsAt:'2030-01-03T12:30:00Z',endsAt:'2030-01-04T12:00:00Z'});
      await assert.rejects(book('confirm',{reservationId:next.id,expectedVersion:next.version}),/RENTAL_CONFLICT/);
      next=await book('create',{...payload,startsAt:'2030-01-04T12:00:00Z',endsAt:'2030-01-05T12:00:00Z'});
      next=await book('confirm',{reservationId:next.id,expectedVersion:next.version});
    });
    await t.test('extension is atomic and returns queryable alternatives; successful extension keeps tariff',async()=>{
      await assert.rejects(book('extend',{reservationId:first.id,expectedVersion:first.version,endsAt:'2030-01-04T14:00:00Z',reason:'Requested extra day'}),/RENTAL_CONFLICT/);
      const alternatives=(await db.query<{id:string}>('select * from public.rental_alternatives($1,$2,$3)',[payload.startsAt,'2030-01-04T15:00:00Z',first.id])).rows;
      assert.ok(alternatives.some(car=>car.id===other.id));assert.ok(!alternatives.some(vehicle=>vehicle.id===car.id));
      first=await book('extend',{reservationId:first.id,expectedVersion:first.version,endsAt:'2030-01-03T15:00:00Z',reason:'Three extra hours'});
      assert.equal(first.total,150);
    });
    await t.test('WhatsApp evidence is immutable, authored and retained after cancellation; merge preserves reservation relation',async()=>{
      const key=crypto.randomUUID();const evidence={reservationId:first.id,body:'Customer agreed the dates via WhatsApp'};
      const saved=await book('evidence',evidence,key);assert.deepEqual(await book('evidence',evidence,key),saved);
      const target=await command<{id:string}>('execute_command','create_customer',{name:'Merged customer',phone:'78901889',type:'Personal'});
      await command('execute_command','merge_customer',{sourceId:customer.id,targetId:target.id,sourceVersion:1,targetVersion:1,reason:'Verified identity'});
      const live=(await db.query<{customer_id:string;version:number}>('select customer_id,version from public.reservations where id=$1',[first.id])).rows[0];
      assert.equal(live.customer_id,target.id);
      await book('cancel',{reservationId:first.id,expectedVersion:live.version,reason:'Customer cancelled'});
      assert.equal((await db.query('select id from public.reservation_evidence where reservation_id=$1',[first.id])).rows.length,1);
      await asUser(technician);assert.equal((await db.query('select * from public.reservations')).rows.length,0);
      await assert.rejects(book('create',payload),/PERMISSION_DENIED/);await asUser(owner);
    });
    await t.test('workshop receipt automatically blocks the vehicle until a planned or actual release',async()=>{
      const order=await command<{id:string}>('execute_command','receive_vehicle',{customerId:(await db.query<{id:string}>('select id from public.customers where merged_into is null')).rows[0].id,vehicleId:other.id,area:'Mecánica',service:'Maintenance'});
      assert.equal((await db.query<{kind:string}>('select kind from public.vehicle_commitments where order_id=$1',[order.id])).rows[0].kind,'Taller');
      const draft=await book('create',{...payload,vehicleId:other.id,customerId:(await db.query<{id:string}>('select id from public.customers where merged_into is null')).rows[0].id});
      await assert.rejects(book('confirm',{reservationId:draft.id,expectedVersion:draft.version}),/RENTAL_CONFLICT/);
      await book('plan_workshop',{orderId:order.id,endsAt:'2029-12-30T12:00:00Z',reason:'Planned completion before rental'});
      await book('confirm',{reservationId:draft.id,expectedVersion:draft.version});
    });
  }finally{await db.close();}
});
