import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationalDb} from './helpers/operational-db';

test('Vehicle cases: real workbook financial examples and private reception evidence',async t=>{
  const {db,command,rpc,asUser,owner,technician}=await operationalDb();
  try{
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
    const customer=await command<{id:string}>('execute_command','create_customer',{
      name:'Case acceptance',phone:'78904701',type:'Personal'});
    const car=await command<{id:string}>('execute_command','create_vehicle',{
      plate:'CASE-EXTERNAL',brand:'Nissan',model:'Rogue',year:2018,category:'SUV',color:'White',
      daily:'0',km:'100',ownership:'Cliente',ownerCustomerId:customer.id});
    const job=await command<{id:string}>('execute_command','receive_vehicle',{
      customerId:customer.id,vehicleId:car.id,area:'Pintura',service:'Workbook acceptance'});
    const caseCommand=<T=Record<string,unknown>>(name:string,payload:Record<string,unknown>,key?:string)=>
      command<T>('execute_case_command',name,payload,key);
    const quote=async(price:string,parentId:string|null)=>caseCommand<{id:string;revision:number;snapshot:{costComplete:boolean;margin:null}}>(
      'quote',{orderId:job.id,parentId,reason:'Reviewed full scope',lines:[
        {description:'Enderezado y pintura',kind:'Trabajo',quantity:'1',unitPrice:price,unitCost:null}]});
    const approve=(id:string)=>command('execute_estimate_command','approve',{
      estimateId:id,approverName:'Acceptance customer',evidence:'Written approval'});
    await t.test('one case has an immutable inspection and actual, authorized photo',async()=>{
      await caseCommand('intake',{orderId:job.id,km:'110',fuel:'50',condition:'Front damage',accessories:'Spare tire'});
      const payload={vehicleId:car.id,orderId:job.id,name:'intake.png',purpose:'Ingreso',mime:'image/png',
        base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
      const args={payload:JSON.stringify(payload),idempotency_key:crypto.randomUUID()};
      const photo=await rpc<{id:string}>('save_vehicle_file',args);
      assert.deepEqual(await rpc('save_vehicle_file',args),photo);
      const stored=await rpc<{base64:string}>('vehicle_file_content',{file_id:photo.id});
      assert.equal(stored.base64.replace(/\s/g,''),payload.base64);
      await assert.rejects(rpc('save_vehicle_file',{...args,idempotency_key:crypto.randomUUID(),
        payload:JSON.stringify({...payload,mime:'image/svg+xml',base64:Buffer.from('<svg/>').toString('base64')})}),/INVALID_VEHICLE_FILE/);
      const report=await rpc<{inspections:unknown[];files:unknown[];orders:{pending_fields:string[]}[]}>(
        'vehicle_case_file',{vehicle_id:car.id,order_id:job.id});
      assert.equal(report.inspections.length,1);assert.equal(report.files.length,1);
      assert.deepEqual(report.orders[0].pending_fields,[]);
    });
    await t.test('1856 + 334 - 750 = 1440; no invented cost and no payment imported as expense',async()=>{
      const initial=await quote('1856',null);
      assert.equal(initial.snapshot.costComplete,false);assert.equal(initial.snapshot.margin,null);
      await approve(initial.id);
      await caseCommand('bill_scope',{orderId:job.id,date:today,dueOn:today});
      const revised=await quote('2190',initial.id);await approve(revised.id);
      const additional=await caseCommand<{id:string;amount:number}>('bill_scope',{orderId:job.id,date:today,dueOn:today});
      assert.equal(additional.amount,334);
      await assert.rejects(caseCommand('bill_scope',{orderId:job.id,date:today,dueOn:today}),/SCOPE_ALREADY_BILLED/);
      const receipt=await command<{id:string}>('execute_billing_command','pay',{
        customerId:customer.id,amount:'750',date:today,method:'Efectivo',account:'Case cash',reference:'One customer payment'});
      const report=await rpc<{documents:{id:string;scope_balance:number}[]}>('vehicle_case_file',{vehicle_id:car.id,order_id:job.id});
      const first=report.documents.find(d=>d.id!==additional.id)!;
      await command('execute_billing_command','apply',{paymentId:receipt.id,documentId:first.id,amount:'750',date:today});
      const final=await rpc<{documents:{scope_balance:number}[];expenses:unknown[];payments:unknown[]}>(
        'vehicle_case_file',{vehicle_id:car.id,order_id:job.id});
      assert.equal(final.documents.reduce((sum,d)=>sum+d.scope_balance,0),1440);
      assert.equal(final.expenses.length,0);assert.equal(final.payments.length,1);
    });
    await t.test('one 120 purchase can cover 75 + 25 + 20 without tripling costs or payments',async()=>{
      const cost=await command<{id:string;version:number}>('execute_cost_command','purchase',{
        orderId:job.id,description:'Three parts in one receipt',quantity:'1',unitCost:'120',supplier:'Parts supplier',sourceReference:'CASE-120',date:today});
      await caseCommand('allocate_cost',{costId:cost.id,expectedVersion:cost.version,reason:'Split receipt',lines:[
        {description:'Part A',amount:'75'},{description:'Part B',amount:'25'},{description:'Part C',amount:'20'}]});
      await rpc('pay_direct_purchase',{cost_id:cost.id,payload:JSON.stringify({date:today,amount:'120',method:'Efectivo',account:'Case cash'}),idempotency_key:crypto.randomUUID()});
      const report=await rpc<{allocations:{amount:number}[];costs:{amount:number}[];expenses:{amount:number}[]}>(
        'vehicle_case_file',{vehicle_id:car.id,order_id:job.id});
      assert.equal(report.costs.length,1);assert.equal(report.costs[0].amount,120);
      assert.equal(report.expenses.length,1);assert.equal(report.allocations.reduce((s,a)=>s+a.amount,0),120);
    });
    await t.test('fleet membership is independent of title; internal maintenance has no dummy customer',async()=>{
      const own=await command<{id:string}>('execute_command','create_vehicle',{
        plate:'CASE-INTERNAL',brand:'Test',model:'Fleet',year:2026,category:'SUV',color:'Blue',daily:'40',km:'0',ownership:'Propio'});
      const internal=await command<{id:string}>('execute_command','receive_vehicle',{
        vehicleId:own.id,internalJob:true,area:'Mecánica',service:'Internal maintenance'});
      const report=await rpc<{orders:{customer_id:null;internal_job:boolean}[]}>('vehicle_case_file',{vehicle_id:own.id,order_id:internal.id});
      assert.equal(report.orders[0].customer_id,null);assert.equal(report.orders[0].internal_job,true);
      await assert.rejects(caseCommand('bill_scope',{orderId:internal.id,date:today,dueOn:today}),/INTERNAL_VEHICLE_NOT_A_SALE/);
      await command('execute_command','record_expense',{vehicleId:own.id,date:today,amount:'15',concept:'Registration fee',category:'Vehicle',method:'Efectivo',account:'Case cash'});
      const all=await rpc<{expenses:{amount:number}[]}>('vehicle_case_file',{vehicle_id:own.id});
      assert.equal(all.expenses[0].amount,15);
    });
    await t.test('read-only reception cannot see financial files; technician cannot read or mutate the dossier',async()=>{
      const photo=await rpc<{id:string}>('save_vehicle_file',{payload:JSON.stringify({
        vehicleId:car.id,orderId:job.id,name:'private.pdf',purpose:'Soporte',financial:true,mime:'application/pdf',
        base64:Buffer.from('%PDF-1.4 financial evidence').toString('base64')}),idempotency_key:crypto.randomUUID()});
      const reception=crypto.randomUUID();await db.exec('reset role');
      await db.query('insert into auth.users values($1,$2)',[reception,'case-reception@local']);
      await db.query("insert into public.user_roles values($1,'reception')",[reception]);await asUser(reception);
      const report=await rpc<{financialAccess:boolean;quotes?:unknown;files:{id:string}[]}>(
        'vehicle_case_file',{vehicle_id:car.id,order_id:job.id});
      assert.equal(report.financialAccess,false);assert.equal(report.quotes,undefined);
      assert.ok(!report.files.some(f=>f.id===photo.id));
      await assert.rejects(rpc('vehicle_file_content',{file_id:photo.id}),/PERMISSION_DENIED/);
      await asUser(technician);await assert.rejects(rpc('vehicle_case_file',{vehicle_id:car.id}),/PERMISSION_DENIED/);
      await assert.rejects(caseCommand('quote',{orderId:job.id}),/PERMISSION_DENIED/);await asUser(owner);
    });
  }finally{await db.close();}
});

test('Vehicle case migration rollback only when unused; reapply preserves prior functions',async()=>{
  const {db,command}=await operationalDb();
  try{
    const rollback=readFileSync('supabase/rollback/20261030000100_vehicle_case_files.sql','utf8');
    await db.exec('reset role');
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
    await db.exec(readFileSync('supabase/rollback/20261030000200_fleet_rental_periods.sql','utf8'));await db.exec(rollback);
    assert.equal((await db.query<{r:string|null}>("select to_regclass('public.vehicle_files')::text r")).rows[0].r,null);
    await db.exec(readFileSync('supabase/migrations/20261030000100_vehicle_case_files.sql','utf8'));
    await db.exec('set role authenticated');
    const c=await command<{id:string}>('execute_command','create_vehicle',{
      plate:'CASE-ROLLBACK',brand:'Test',model:'Guard',year:2026,category:'SUV',color:'White',daily:'0',km:'0',ownership:'Propio'});
    await command('execute_command','record_expense',{vehicleId:c.id,date:'2026-01-01',concept:'Preserve case data',category:'Vehicle',amount:'10',method:'Efectivo',account:'Test'});
    await db.exec('reset role');await assert.rejects(db.exec(rollback),/Rollback refused/);await db.exec('rollback');
    assert.equal((await db.query('select id from public.expenses')).rows.length,1);
  }finally{await db.close();}
});
