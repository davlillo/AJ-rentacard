import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';
import type {CaseFile} from '../src/lib/supabase/cases';
import type {Reservation} from '../src/lib/supabase/reservations';

test('Customer workshop intake, private identity photos and free reviews preserve existing operational guards',async()=>{
  const {db,rpc,command,asUser,technician,owner}=await operationalDb();
  const invoke=<T=Record<string,unknown>>(fn:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>rpc<T>(fn,{payload:JSON.stringify(payload),idempotency_key:key});
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Workshop customer',phone:'',type:'Personal'});
    const intake={customerId:customer.id,service:'Customer repair',area:'Mecánica',newVehicle:{plate:'POLISH-CAR',brand:'Nissan',model:'Customer',year:'2020'}};
    const key=crypto.randomUUID();const saved=await invoke<{id:string;vehicleId:string}>('receive_workshop_vehicle',intake,key);
    assert.deepEqual(await invoke('receive_workshop_vehicle',intake,key),saved);
    const file=await rpc<CaseFile>('vehicle_case_file',{vehicle_id:saved.vehicleId,order_id:saved.id});
    assert.equal(file.vehicle.in_rental_fleet,false);assert.equal(file.vehicle.ownership,'Cliente');assert.equal(file.orders[0].customer_id,customer.id);
    assert.ok(file.vehicle.unverified_fields?.includes('km'));assert.equal(file.vehicle.status,'En taller');
    const existing=await command<{id:string}>('execute_command','create_vehicle',{plate:'EXISTING-CLIENT',brand:'Test',model:'Workshop',year:2020,
      category:'SUV',color:'',daily:0,km:0,ownership:'Cliente',ownerCustomerId:customer.id,inRentalFleet:false,initialStatus:'Por confirmar',unverifiedFields:['km','status']});
    assert.ok((await invoke('receive_workshop_vehicle',{customerId:customer.id,vehicleId:existing.id,expectedVersion:1,service:'Previously registered customer car',area:'Mecánica'})).id);
    await assert.rejects(invoke('receive_workshop_vehicle',{...intake,newVehicle:null,vehicleId:saved.vehicleId,expectedVersion:file.vehicle.version}),/VEHICLE_HAS_OPEN_WORK/);
    await command('execute_case_command','intake',{orderId:saved.id,km:null,fuel:null,condition:'Mileage 12345 km; fuel half; spare tire present.',accessories:''});
    const reviewed=await rpc<CaseFile>('vehicle_case_file',{vehicle_id:saved.vehicleId,order_id:saved.id});
    assert.equal(reviewed.inspections[0].km,null);assert.equal(reviewed.inspections[0].fuel,null);
    assert.ok(reviewed.vehicle.unverified_fields?.includes('km'));assert.equal(reviewed.vehicle.km,0);
    const count=(await db.query('select id from public.vehicles')).rows.length;
    await assert.rejects(invoke('receive_workshop_vehicle',{...intake,service:'',newVehicle:{...intake.newVehicle,plate:'ROLLBACK-ONLY'}}));
    assert.equal((await db.query('select id from public.vehicles')).rows.length,count);
    const owned=await command<{id:string}>('execute_command','create_vehicle',{plate:'POLISH-FLEET',brand:'Nissan',model:'Fleet',year:2020,
      category:'SUV',color:'White',daily:40,km:500,ownership:'Propio',inRentalFleet:true});
    await assert.rejects(invoke('receive_workshop_vehicle',{customerId:customer.id,vehicleId:owned.id,expectedVersion:1,service:'Wrong intake',area:'Mecánica'}),/CUSTOMER_WORKSHOP_VEHICLE_REQUIRED/);
    const updated=await rpc<{type:string;version:number}>('save_registry_details',{kind:'customer',payload:JSON.stringify({id:customer.id,
      expectedVersion:1,name:'Updated customer',phone:'',email:'',document:'',type:'Empresa',reason:'Verified customer details'}),idempotency_key:crypto.randomUUID()});
    assert.equal(updated.type,'Empresa');
    const photo={customerId:customer.id,kind:'DUI',name:'DUI.png',mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aElkAAAAASUVORK5CYII='};
    const photoKey=crypto.randomUUID();const document=await invoke<{id:string}>('save_customer_document',photo,photoKey);
    assert.deepEqual(await invoke('save_customer_document',photo,photoKey),document);
    assert.equal((await rpc<unknown[]>('customer_document_list',{customer_id:customer.id})).length,1);
    assert.equal((await rpc<{mime:string}>('customer_document_content',{file_id:document.id})).mime,'image/png');
    await assert.rejects(invoke('save_customer_document',{...photo,mime:'image/jpeg'}),/INVALID_CUSTOMER_DOCUMENT/);
    const alias=await command<{id:string}>('execute_command','create_customer',{name:'Preserved document owner',phone:'',type:'Personal'});
    await invoke('save_customer_document',{...photo,customerId:alias.id,kind:'Licencia'});
    await command('execute_command','merge_customer',{sourceId:alias.id,targetId:customer.id,sourceVersion:1,targetVersion:updated.version,reason:'Same customer verified'});
    assert.equal((await rpc<unknown[]>('customer_document_list',{customer_id:customer.id})).length,2);
    const logged=(await db.query<{request:Record<string,unknown>}>('select request from private.command_results where key=$1',[photoKey]).catch(()=>({rows:[]}))).rows;
    // The private log is not directly readable by browser roles.
    assert.equal(logged.length,0);
    await asUser(technician);
    assert.equal((await db.query('select id from public.customer_documents')).rows.length,0);
    await assert.rejects(rpc('customer_document_content',{file_id:document.id}),/PERMISSION_DENIED/);
    await assert.rejects(invoke('save_customer_document',photo,photoKey),/PERMISSION_DENIED/);
    await assert.rejects(invoke('receive_workshop_vehicle',intake,key),/PERMISSION_DENIED/);
    await asUser(owner);
    let booking=await command<Reservation>('execute_reservation_command','create',{customerId:customer.id,vehicleId:owned.id,
      startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:'40',cleaningMinutes:30});
    booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
    const review={reservationId:booking.id,km:null,fuel:null,condition:'All observations in a single free-text review.',accessories:'',evidence:'All observations in a single free-text review.'};
    booking=(await command<{reservation:Reservation}>('execute_rental_command','depart',{...review,expectedVersion:booking.version})).reservation;
    await assert.rejects(command('execute_rental_command','return',{...review,km:499,expectedVersion:booking.version}),/ODOMETER_CANNOT_DECREASE/);
    await command('execute_rental_command','return',{...review,expectedVersion:booking.version});
    const rental=await rpc<CaseFile>('rental_case_file',{reservation_id:booking.id});
    assert.ok(rental.reservations[0].actual_return_at);assert.ok(rental.reservations[0].actual_departure_at);assert.equal(rental.vehicle.km,500);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
    await command('execute_command','record_expense',{concept:'Polish test expense',category:'Test',amount:'1',date:today,method:'Efectivo',account:'Test cash',costCenterId:'administration'});
    const diary=await rpc<{rows:{created_at:string}[]}>('cash_diary',{from_date:today,to_date:today});assert.ok(diary.rows[0].created_at);
    await db.exec('reset role');
    const request=(await db.query<{request:Record<string,unknown>}>('select request from private.command_results where key=$1',[photoKey])).rows[0].request;
    assert.ok(!JSON.stringify(request).includes(photo.base64));assert.ok(!('base64' in request));
    await assert.rejects(db.exec(readFileSync('supabase/rollback/20261109000200_private_customer_documents.sql','utf8')),/CUSTOMER_DOCUMENTS_ALREADY_USED/);
    await assert.rejects(db.exec(readFileSync('supabase/rollback/20261109000100_targeted_operational_polish.sql','utf8')),/POLISH_ALREADY_USED/);
  }finally{await db.close();}
});

test('Unused polish migrations can roll back without touching existing data',async()=>{
  const {db}=await operationalDb();
  try{
    await db.exec('reset role');
    await db.exec(readFileSync('supabase/rollback/20261109000200_private_customer_documents.sql','utf8'));
    await db.exec(readFileSync('supabase/rollback/20261109000100_targeted_operational_polish.sql','utf8'));
    assert.equal((await db.query<{required:string}>("select is_nullable required from information_schema.columns where table_schema='public' and table_name='rental_inspections' and column_name='km'")).rows[0].required,'NO');
  }finally{await db.close();}
});
