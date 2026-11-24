import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';

const addDays=(value:string,days:number)=>{
  const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
};
const salvadorToday=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
const dateOnly=(value:unknown)=>value instanceof Date?value.toISOString().slice(0,10):String(value??'');

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

// A rental with the inspection flow already run: it returns the approved extra of the folio.
async function prepareExtra(ctx:Awaited<ReturnType<typeof operationalDb>>,options:{approved?:boolean;plate:string;phone:string}){
  const {db,command,rpc}=ctx;
  const customer=await command<{id:string}>('execute_command','create_customer',{name:'Extra customer',phone:options.phone,type:'Personal'});
  const car=await command<{id:string}>('execute_command','create_vehicle',{plate:options.plate,brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:50,km:100,ownership:'Propio'});
  let booking=await command<{id:string;version:number}>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
    startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:'50',cleaningMinutes:30});
  booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
  const inspection={reservationId:booking.id,expectedVersion:booking.version,km:'100',fuel:'100',condition:'No damage',accessories:'Spare tire',evidence:'Synthetic handover record'};
  const outgoing=await command<{reservation:{id:string;version:number}}>('execute_rental_command','depart',inspection);
  await command('execute_rental_command','return',{...inspection,expectedVersion:outgoing.reservation.version,km:'150',fuel:'70',
    condition:'New door dent',evidence:'Synthetic return record'});
  const proposal=(await db.query<{id:string;version:number;status:string;amount:number|null}>(
    'select id,version,status,amount from public.rental_extra_proposals where reservation_id=$1',[booking.id])).rows[0];
  if(options.approved!==false){
    await command('execute_rental_command','decide_extra',{proposalId:proposal.id,expectedVersion:proposal.version,
      decision:'Aprobado',amount:'25.00',reason:'Daño confirmado en la devolución'});
  }
  const approved=(await db.query<{id:string;version:number;status:string;amount:number|null}>(
    'select id,version,status,amount from public.rental_extra_proposals where id=$1',[proposal.id])).rows[0];
  const issue=(payload:unknown,key=crypto.randomUUID())=>rpc<Record<string,unknown>>('issue_rental_extra',
    {payload:JSON.stringify(payload),idempotency_key:key});
  return{customer,car,booking,proposal:approved,issue};
}

async function rentalWithExtra(options:{approved?:boolean;plate:string;phone:string}){
  const ctx=await operationalDb();
  return{...ctx,...await prepareExtra(ctx,options)};
}

test('an approved extra is still only a decision: it creates no billing document',async()=>{
  const {db,proposal,booking}=await rentalWithExtra({plate:'EXTRA-1',phone:'78901912'});
  try{
    assert.equal(proposal.status,'Aprobado');assert.equal(Number(proposal.amount),25);
    const documents=(await db.query<{id:string}>('select id from public.billing_documents where reservation_id=$1',[booking.id])).rows;
    assert.equal(documents.length,0,'the gap: approving an extra never created a document to charge');
    const marked=(await db.query<{document_id:string|null}>('select document_id from public.rental_extra_proposals where id=$1',[proposal.id])).rows[0];
    assert.equal(marked.document_id,null);
  }finally{await db.close();}
});

test('issuing an approved extra creates exactly one collectible document and never a period',async()=>{
  const {db,owner,technician,proposal,booking,customer,issue,asUser}=await rentalWithExtra({plate:'EXTRA-2',phone:'78901913'});
  try{
    const today=salvadorToday();const dueOn=addDays(today,14);
    const payload={proposalId:proposal.id,expectedVersion:proposal.version,date:today,dueOn,reason:'Se emite el importe aprobado del extra'};
    // A stale version never issues anything.
    await assert.rejects(issue({...payload,expectedVersion:proposal.version-1}),/VERSION_CONFLICT/);
    // A future emission date is never a document.
    await assert.rejects(issue({...payload,date:addDays(today,3)}),/INVALID_BILLING_AMOUNT_DATE/);
    // The reason is not optional.
    await assert.rejects(issue({...payload,reason:'   '}),/EXTRA_REASON_REQUIRED/);
    // A technician without expenses.write never issues anything.
    await asUser(technician);
    await assert.rejects(issue(payload),/PERMISSION_DENIED/);
    await asUser(owner);
    // A payload that is not an object is never a command.
    await assert.rejects(issue([1,2]),/INVALID_REQUEST/);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,0);

    const key=crypto.randomUUID();
    const issued=await issue(payload,key);
    const document=(await db.query<{id:string;reservation_id:string;amount:string;source_key:string;customer_id:string;issued_on:string;due_on:string}>(
      'select id,reservation_id,amount,source_key,customer_id,issued_on,due_on from public.billing_documents')).rows;
    assert.equal(document.length,1,'the extra creates exactly one document');
    assert.equal(document[0].reservation_id,booking.id);
    assert.equal(Number(document[0].amount),25);
    assert.equal(document[0].source_key,'rental-extra:'+proposal.id);
    assert.equal(document[0].customer_id,customer.id);
    assert.equal(dateOnly(document[0].issued_on),today);assert.equal(dateOnly(document[0].due_on),dueOn);
    const marked=(await db.query<{document_id:string;issued_on:string;due_on:string;version:number}>(
      'select document_id,issued_on,due_on,version from public.rental_extra_proposals where id=$1',[proposal.id])).rows[0];
    assert.equal(marked.document_id,document[0].id);
    assert.equal(dateOnly(marked.issued_on),today);assert.equal(dateOnly(marked.due_on),dueOn);
    assert.equal(marked.version,proposal.version+1,'the version moves so a stale client cannot reuse it');
    // An extra is not a period of occupancy.
    assert.equal((await db.query('select id from public.rental_periods')).rows.length,0);
    assert.equal((await db.query<{paid:Date|null}>('select public.rental_paid_through($1::uuid) paid',[booking.id])).rows[0].paid,null);
    // The same key replays the same result and never documents the extra twice.
    assert.deepEqual(await issue(payload,key),issued);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,1);
    // A new key over an issued extra never documents it again.
    await assert.rejects(issue(payload,crypto.randomUUID()),/EXTRA_ALREADY_ISSUED/);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,1);
  }finally{await db.close();}
});

test('the issued extra is visible in the folio and in the receivables of the business',async()=>{
  const {db,proposal,booking,issue,rpc}=await rentalWithExtra({plate:'EXTRA-3',phone:'78901914'});
  try{
    const today=salvadorToday();
    await issue({proposalId:proposal.id,expectedVersion:proposal.version,date:today,dueOn:addDays(today,14),
      reason:'Se emite el importe aprobado del extra'});
    const file=await rpc<{documents:{id:string;scope_amount:number;scope_balance:number}[]}>('rental_case_file',{reservation_id:booking.id});
    const document=file.documents.find(row=>row.id!=='');
    assert.equal(file.documents.length,1);
    assert.equal(Number(document?.scope_amount),25);
    assert.equal(Number(document?.scope_balance),25,'the extra is owed, not paid');
    const receivables=await rpc<{id:string;reservation_id:string;amount:number;balance:number}[]>('receivables_at',{cutoff:addDays(today,1)});
    const receivable=receivables.find(row=>row.reservation_id===booking.id);
    assert.equal(Number(receivable?.amount),25);
    assert.equal(Number(receivable?.balance),25);
  }finally{await db.close();}
});

test('a proposed extra is never issued',async()=>{
  const {db,proposal,issue}=await rentalWithExtra({approved:false,plate:'EXTRA-5',phone:'78901917'});
  try{
    assert.equal(proposal.status,'Propuesto');
    await assert.rejects(issue({proposalId:proposal.id,expectedVersion:proposal.version,date:salvadorToday(),
      dueOn:addDays(salvadorToday(),14),reason:'Se emite el importe aprobado del extra'}),/EXTRA_NOT_APPROVED/);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,0);
  }finally{await db.close();}
});

test('the rollback of the extra removes the command only while nothing was issued',async()=>{
  const ctx=await operationalDb();
  const {db,owner,asUser}=ctx;
  try{
    const rollback=readFileSync('supabase/rollback/20261115000100_rental_extra_charge.sql','utf8');
    const migration=readFileSync('supabase/migrations/20261115000100_rental_extra_charge.sql','utf8');
    const {proposal,issue}=await prepareExtra(ctx,{plate:'EXTRA-6',phone:'78901918'});
    // Nothing was issued yet: the link and the command can go.
    await db.exec('reset role');
    await db.exec(rollback);
    assert.equal((await db.query<{count:number}>("select count(*) count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='issue_rental_extra'")).rows[0].count,0);
    assert.equal((await db.query<{name:string|null}>("select to_regclass('public.rental_extra_proposals')::text name")).rows[0].name,'rental_extra_proposals');
    assert.equal((await db.query<{column:string|null}>("select column_name from information_schema.columns where table_name='rental_extra_proposals' and column_name='document_id'")).rows.length,0);
    // And they come back with the migration.
    await db.exec(migration);
    assert.equal((await db.query<{count:number}>("select count(*) count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='issue_rental_extra'")).rows[0].count,1);
    await asUser(owner);
    const today=salvadorToday();
    await issue({proposalId:proposal.id,expectedVersion:proposal.version,date:today,dueOn:addDays(today,14),
      reason:'Se emite el importe aprobado del extra'});
    // An issued charge is never orphaned: the rollback refuses.
    await db.exec('reset role');
    await assert.rejects(db.exec(rollback),/RENTAL_EXTRA_ALREADY_ISSUED/);
    assert.equal((await db.query<{count:number}>("select count(*) count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='issue_rental_extra'")).rows[0].count,1);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,1);
  }finally{await db.close();}
});

test('an extra of a cancelled rental is never issued',async()=>{
  const {db,owner,command,rpc,asUser}=await rentalWithExtra({approved:false,plate:'EXTRA-4',phone:'78901915'});
  try{
    // A confirmed reservation that is cancelled before the extra is issued.
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'EXTRA-4B',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:50,km:100,ownership:'Propio'});
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'Cancelled customer',phone:'78901916',type:'Personal'});
    let booking=await command<{id:string;version:number}>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,
      startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),dailyRate:'50',cleaningMinutes:30});
    booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});
    booking=await command('execute_reservation_command','cancel',{reservationId:booking.id,expectedVersion:booking.version,reason:'El cliente cancela el alquiler'});
    await db.exec('reset role');
    await db.query(`insert into public.rental_extra_proposals(reservation_id,description,comparison,amount,status,reason,version,created_by)
      values($1,'Extra de una reserva cancelada','{}'::jsonb,25,'Aprobado','Prueba de guarda',1,$2)`,[booking.id,owner]);
    await asUser(owner);
    const proposal=(await db.query<{id:string;version:number}>('select id,version from public.rental_extra_proposals where reservation_id=$1',[booking.id])).rows[0];
    await assert.rejects(rpc('issue_rental_extra',{payload:JSON.stringify({proposalId:proposal.id,expectedVersion:proposal.version,
      date:salvadorToday(),dueOn:addDays(salvadorToday(),14),reason:'Se emite el importe aprobado del extra'}),idempotency_key:crypto.randomUUID()}),
      /RENTAL_CANCELLED/);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,0);
  }finally{await db.close();}
});
