import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {localStatus} from '../../scripts/setup-local.mjs';

// Explicit opt-in integration suite. Creates synthetic records in AJ LOCAL ONLY.
// Never reset/truncate a database to run acceptance tests.
test('AJ local Supabase HTTP/Auth/RLS and concurrent commands', async () => {
  const health = await fetch('http://127.0.0.1:55321/auth/v1/health', {signal: AbortSignal.timeout(5000)})
    .catch(() => null);
  assert.ok(health, 'AJ Supabase is unavailable. Run local:start; verify disk space and Docker.');
  const status = localStatus();
  const auth = {persistSession: false, autoRefreshToken: false};
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {auth});
  const run = crypto.randomUUID();
  async function login(role: string) {
    const email = `test-${role}-${run}@aj.local`;
    const password = crypto.randomUUID() + crypto.randomUUID();
    const {data, error} = await admin.auth.admin.createUser({email,password,email_confirm:true});
    assert.ifError(error);
    assert.ok(data.user);
    assert.ifError((await admin.from('user_roles').insert({user_id:data.user.id,role})).error);
    const client = createClient(status.API_URL, status.ANON_KEY, {auth});
    assert.ifError((await client.auth.signInWithPassword({email,password})).error);
    return client;
  }
  const owner = await login('owner');
  const technician = await login('technician');
  const command = (name: string, payload: Record<string, unknown>, key = crypto.randomUUID()) =>
    owner.rpc('execute_command', {command:name,payload,idempotency_key:key});
  try {
    const customer = {name:`Acceptance ${run}`,phone:String(randomInt(10000000,99999999)),
      document:`TEST-${run}`,email:'',type:'Personal'};
    const concurrent = await Promise.all([command('create_customer',customer),command('create_customer',customer)]);
    assert.equal(concurrent.filter(response => !response.error).length,1);
    assert.equal(concurrent.filter(response => response.error?.message === 'CUSTOMER_MATCH_EXISTS').length,1);
    const customerId = concurrent.find(response => !response.error)!.data.id;
    const car = await command('create_vehicle',{plate:`TEST-${run}`,brand:'Test',model:'Local',year:2026,
      category:'Sedán',color:'Gris',daily:0,km:0,ownership:'Cliente',ownerCustomerId:customerId});
    assert.ifError(car.error);
    const receipt = {customerId,vehicleId:car.data.id,service:'HTTP acceptance',area:'Mecánica'};
    const received = await Promise.all([command('receive_vehicle',receipt),command('receive_vehicle',receipt)]);
    assert.equal(received.filter(response => !response.error).length,1);
    assert.equal(received.filter(response => response.error?.message === 'VEHICLE_UNAVAILABLE').length,1);
    const operationId = received.find(response => !response.error)!.data.id;
    const expense = {operationId,costCenterId:null,date:'2026-10-22',concept:`Test ${run}`,category:'Test',
      amount:'35.10',method:'Efectivo',account:'Test cashbox'};
    const key = crypto.randomUUID();
    const paid = await Promise.all([command('record_expense',expense,key),command('record_expense',expense,key)]);
    paid.forEach(response => assert.ifError(response.error));
    assert.equal(paid[0].data.id,paid[1].data.id);
    const ledger = await owner.from('expenses').select('*').eq('operation_id',operationId);
    assert.ifError(ledger.error);
    assert.equal(ledger.data?.length,1);
    assert.equal(Number(ledger.data?.[0].amount),35.10);
    const secondCustomer = await command('create_customer',{...customer,name:`Survivor ${run}`,
      phone:String(randomInt(10000000,99999999)),document:`SURVIVOR-${run}`});
    assert.ifError(secondCustomer.error);
    const merge = await command('merge_customer',{sourceId:customerId,targetId:secondCustomer.data.id,
      sourceVersion:1,targetVersion:1,reason:'Local acceptance identity verification'});
    assert.ifError(merge.error);
    const alias = await owner.rpc('customer_matches',{phone:customer.phone,document:customer.document});
    assert.ifError(alias.error);
    assert.equal(alias.data?.[0].id,secondCustomer.data.id);
    assert.equal((await owner.from('vehicles').select('owner_customer_id').eq('id',car.data.id)).data?.[0].owner_customer_id,secondCustomer.data.id);
    assert.equal((await owner.from('work_orders').select('customer_id').eq('id',operationId)).data?.[0].customer_id,secondCustomer.data.id);

    const source = {date:'2026-10-22',concept:`Imported ${run}`,category:'Materials',amount:'18.75',
      method:'Efectivo',account:'Test cashbox',operationId,sourceKey:`IMPORT-${run}`};
    const rawRows = [{rowNumber:2,cells:source,hasFormula:false},
      {rowNumber:3,cells:{...source,amount:'bad',sourceKey:`BAD-${run}`},hasFormula:false}];
    const stageArgs = {file_name:`test-${run}.csv`,file_base64:Buffer.from(JSON.stringify(rawRows)).toString('base64'),
      sheet_name:'Ledger',columns:Object.keys(source),rows:rawRows};
    const staged = await Promise.all([owner.rpc('stage_expense_import',stageArgs),owner.rpc('stage_expense_import',stageArgs)]);
    staged.forEach(response => assert.ifError(response.error));
    assert.equal(staged[0].data.id,staged[1].data.id);
    assert.equal((await owner.from('expenses').select('id').eq('operation_id',operationId)).data?.length,1);
    const mapping = Object.fromEntries(Object.keys(source).map(key => [key,key]));
    const validated = await owner.rpc('validate_expense_import',{batch_id:staged[0].data.id,
      expected_version:staged[0].data.version,mapping,source_system:`test-${run}`,decisions:{}});
    assert.ifError(validated.error);
    assert.equal(validated.data.summary.rejected,1);
    assert.ok((await owner.rpc('commit_expense_import',{batch_id:validated.data.id,
      expected_version:validated.data.version,expected_new_total:'18.75'})).error);
    const resolved = await owner.rpc('validate_expense_import',{batch_id:validated.data.id,
      expected_version:validated.data.version,mapping,source_system:`test-${run}`,
      decisions:{'3':{action:'exclude',reason:'Invalid synthetic source row reviewed'}}});
    assert.ifError(resolved.error);
    const commitArgs = {batch_id:resolved.data.id,expected_version:resolved.data.version,expected_new_total:'18.75'};
    const committed = await Promise.all([owner.rpc('commit_expense_import',commitArgs),owner.rpc('commit_expense_import',commitArgs)]);
    committed.forEach(response => assert.ifError(response.error));
    assert.equal(committed[0].data.id,committed[1].data.id);
    assert.equal((await owner.from('expenses').select('id').eq('operation_id',operationId)).data?.length,2);
    const repeated = await owner.rpc('stage_expense_import',stageArgs);
    assert.ifError(repeated.error);
    assert.equal(repeated.data.status,'committed');
    const anotherBook = await owner.rpc('stage_expense_import',{...stageArgs,file_name:`another-${run}.csv`,
      file_base64:Buffer.from(`another ${run}`).toString('base64'),rows:[rawRows[0]]});
    assert.ifError(anotherBook.error);
    const duplicated = await owner.rpc('validate_expense_import',{batch_id:anotherBook.data.id,
      expected_version:anotherBook.data.version,mapping,source_system:`test-${run}`,decisions:{}});
    assert.ifError(duplicated.error);
    assert.equal(duplicated.data.summary.duplicate,1);
    assert.ifError((await owner.rpc('commit_expense_import',{batch_id:duplicated.data.id,
      expected_version:duplicated.data.version,expected_new_total:'0'})).error);
    assert.equal((await owner.from('expenses').select('id').eq('operation_id',operationId)).data?.length,2);
    const denied = await technician.from('expenses').select('*').eq('id',paid[0].data.id);
    assert.deepEqual(denied.data,[]);
    const mutation = await technician.rpc('execute_command',{
      command:'record_expense',payload:expense,idempotency_key:crypto.randomUUID(),
    });
    assert.equal(mutation.error?.code,'42501');
    assert.deepEqual((await technician.from('expense_import_rows').select('*').eq('import_id',resolved.data.id)).data,[]);
    assert.equal((await technician.rpc('expense_import_original',{batch_id:resolved.data.id})).error?.code,'42501');
    const anonymous = createClient(status.API_URL,status.ANON_KEY,{auth});
    assert.ok((await anonymous.rpc('execute_command',{
      command:'record_expense',payload:expense,idempotency_key:crypto.randomUUID(),
    })).error);
    const fresh = createClient(status.API_URL,status.ANON_KEY,{auth});
    const {data: sessionData} = await owner.auth.getSession();
    assert.ok(sessionData.session);
    await fresh.auth.setSession(sessionData.session);
    assert.equal((await fresh.from('work_orders').select('id').eq('id',operationId)).data?.length,1);
    // Exercise exactly the alias selectors used by the browser adapter, not only raw tables.
    process.env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = status.ANON_KEY;
    const {createSupabaseBrowserClient} = await import('../../src/lib/supabase/client');
    const {loadBusiness} = await import('../../src/lib/supabase/business');
    const browserClient = createSupabaseBrowserClient();
    assert.ifError((await browserClient.auth.setSession(sessionData.session)).error);
    const snapshot = await loadBusiness();
    assert.ok(snapshot.customers.some(record => record.id === secondCustomer.data.id && record.aliases?.some(alias => alias.phone === customer.phone)));
    assert.ok(!snapshot.customers.some(record => record.id === customerId));
    assert.equal(snapshot.vehicles.find(record => record.id === car.data.id)?.ownerCustomerId,secondCustomer.data.id);
    assert.equal(snapshot.orders.find(record => record.id === operationId)?.vehicleId,car.data.id);
    assert.equal(snapshot.movements.filter(record => record.operation === operationId).length,2);
    const {data: workerIdentity,error: workerIdentityError} = await technician.auth.getUser();
    assert.ifError(workerIdentityError);
    assert.ok(workerIdentity.user);
    const assignees = await owner.rpc('workshop_assignees');
    assert.ifError(assignees.error);
    assert.ok(assignees.data?.some((person: {id: string}) => person.id === workerIdentity.user!.id));
    const tasks = await Promise.all(['Brake check','Paint check'].map(description => owner.rpc('execute_task_command',{
      command:'create',payload:{orderId:operationId,description:`${description} ${run}`,
        assignedTo:description === 'Brake check' ? workerIdentity.user!.id : sessionData.session!.user.id},
      idempotency_key:crypto.randomUUID(),
    })));
    tasks.forEach(response => assert.ifError(response.error));
    const visibleTasks = await technician.from('workshop_tasks').select('*').eq('order_id',operationId);
    assert.ifError(visibleTasks.error);
    assert.equal(visibleTasks.data?.length,1);
    assert.equal((await technician.from('work_orders').select('*').eq('id',operationId)).data?.length,0);
    assert.ok((await technician.rpc('workshop_assignees')).error);
    const started = await technician.rpc('execute_task_command',{command:'transition',
      payload:{taskId:tasks[0].data.id,expectedVersion:tasks[0].data.version,status:'En proceso'},idempotency_key:crypto.randomUUID()});
    assert.ifError(started.error);
    const finishPayload = {taskId:started.data.id,expectedVersion:started.data.version,status:'Finalizada'};
    const finishKey = crypto.randomUUID();
    const completedTasks = await Promise.all([1,2].map(() => technician.rpc('execute_task_command',{
      command:'transition',payload:finishPayload,idempotency_key:finishKey,
    })));
    completedTasks.forEach(response => assert.ifError(response.error));
    assert.equal((await owner.from('workshop_tasks').select('status').eq('id',tasks[1].data.id)).data?.[0].status,'Pendiente');
    assert.equal((await owner.from('work_orders').select('status').eq('id',operationId)).data?.[0].status,'Diagnóstico');
    assert.equal((await loadBusiness()).tasks?.filter(task => task.orderId === operationId).length,2);
    const estimateCommand=(name:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>
      owner.rpc('execute_estimate_command',{command:name,payload,idempotency_key:key});
    const tariff=await estimateCommand('tariff',{code:`TEST-${run}`,description:'HTTP repair',kind:'Trabajo',unitCost:'250',unitPrice:'350'});
    assert.ifError(tariff.error);
    const quoteLines=[{tariffId:tariff.data.id,quantity:'1'}];
    const calculation={lines:quoteLines,method:'margin',ratio:'0.25',discount:'0'};
    const computed=await owner.rpc('calculate_estimate',calculation);
    assert.ifError(computed.error);assert.equal(computed.data.total,333.33);
    assert.deepEqual((await owner.rpc('calculate_estimate',calculation)).data,computed.data);
    const newVersion={orderId:operationId,parentId:null,reason:'HTTP initial scope',...calculation};
    const drafts=await Promise.all([estimateCommand('version',newVersion),estimateCommand('version',newVersion)]);
    assert.equal(drafts.filter(response=>!response.error).length,1);
    assert.equal(drafts.filter(response=>response.error?.message==='PARENT_VERSION_CONFLICT').length,1);
    const draft=drafts.find(response=>!response.error)!.data;
    const approveKey=crypto.randomUUID();
    const approval={estimateId:draft.id,approverName:'Synthetic customer',evidence:'Recorded synthetic acceptance'};
    const decisions=await Promise.all([estimateCommand('approve',approval,approveKey),estimateCommand('approve',approval,approveKey)]);
    decisions.forEach(response=>assert.ifError(response.error));
    assert.equal(decisions[0].data.status,'Aprobado');
    assert.equal((await owner.from('estimate_approvals').select('id').eq('estimate_id',draft.id)).data?.length,1);
    assert.ok((await owner.from('estimate_versions').update({snapshot:{}}).eq('id',draft.id)).error);
    const supplement=await estimateCommand('version',{...newVersion,parentId:draft.id,reason:'Additional complete scope',lines:[{tariffId:tariff.data.id,quantity:'2'}]});
    assert.ifError(supplement.error);assert.equal(supplement.data.revision,2);
    assert.equal((await owner.from('work_orders').select('estimate').eq('id',operationId)).data?.[0].estimate,333.33);
    const {createBusinessPdf,quoteDocumentContent}=await import('../../src/lib/documents/pdf');
    const {readFileSync}=await import('node:fs');
    const pdf=await createBusinessPdf(quoteDocumentContent(decisions[0].data),readFileSync('public/fonts/manrope-latin-regular.woff'));
    const pdfArgs={estimate_id:draft.id,expected_status:'Aprobado',pdf_base64:Buffer.from(pdf).toString('base64')};
    const documents=await Promise.all([owner.rpc('estimate_pdf',pdfArgs),owner.rpc('estimate_pdf',pdfArgs)]);
    documents.forEach(response=>assert.ifError(response.error));
    assert.equal(documents[0].data.id,documents[1].data.id);
    const {createHash}=await import('node:crypto');
    assert.equal(documents[0].data.hash,createHash('sha256').update(pdf).digest('hex'));
    assert.deepEqual(Buffer.from(documents[0].data.base64,'base64'),Buffer.from(pdf));
    assert.deepEqual((await technician.from('estimate_versions').select('*').eq('id',draft.id)).data,[]);
    assert.equal((await technician.rpc('estimate_pdf',{estimate_id:draft.id,expected_status:'Aprobado'})).error?.code,'42501');
    assert.equal((await owner.from('workshop_costs').select('id').eq('order_id',operationId)).data?.length,2);
    const purchasePayload={orderId:operationId,description:'Unexpected HTTP part',quantity:'2',unitCost:'17.555',
      supplier:`Supplier ${run}`,sourceReference:'invoice/line-1',date:'2026-10-22'};
    const purchaseKey=crypto.randomUUID();
    const purchases=await Promise.all([1,2].map(()=>owner.rpc('execute_cost_command',{
      command:'purchase',payload:purchasePayload,idempotency_key:purchaseKey})));
    purchases.forEach(response=>assert.ifError(response.error));
    assert.equal(purchases[0].data.id,purchases[1].data.id);assert.equal(purchases[0].data.amount,35.11);
    assert.equal(purchases[0].data.disposition,'Pendiente');
    assert.equal((await owner.from('expenses').select('id').eq('operation_id',operationId)).data?.length,2);
    const classified=await owner.rpc('execute_cost_command',{command:'classify',idempotency_key:crypto.randomUUID(),
      payload:{costId:purchases[0].data.id,expectedVersion:1,disposition:'Adicional autorizado',estimateId:draft.id,reason:'Approved initial scope includes this component'}});
    assert.ifError(classified.error);assert.equal(classified.data.version,2);
    assert.deepEqual((await technician.from('workshop_costs').select('*').eq('order_id',operationId)).data,[]);
    const activeTask=await owner.rpc('execute_task_command',{command:'transition',idempotency_key:crypto.randomUUID(),
      payload:{taskId:tasks[1].data.id,expectedVersion:tasks[1].data.version,status:'En proceso'}});
    assert.ifError(activeTask.error);
    const time=(command:string,payload:Record<string,unknown>,key=crypto.randomUUID())=>
      owner.rpc('execute_time_command',{command,payload,idempotency_key:key});
    const startKey=crypto.randomUUID();const timerStarts=await Promise.all([time('start',{taskId:activeTask.data.id},startKey),time('start',{taskId:activeTask.data.id},startKey)]);
    timerStarts.forEach(response=>assert.ifError(response.error));
    assert.equal(timerStarts[0].data.timer.id,timerStarts[1].data.timer.id);
    const paused=await time('pause',{timerId:timerStarts[0].data.timer.id,expectedVersion:timerStarts[0].data.timer.version});
    assert.ifError(paused.error);
    const spans=await owner.from('task_time_spans').select('*').eq('timer_id',paused.data.timer.id);
    assert.ifError(spans.error);assert.equal(spans.data?.length,1);assert.ok(spans.data?.[0].ended_at);
    const finishTimer=await time('finish',{timerId:paused.data.timer.id,expectedVersion:paused.data.timer.version});
    assert.ifError(finishTimer.error);
    assert.equal((await owner.from('task_time_spans').select('active_seconds').eq('id',spans.data![0].id)).data?.[0].active_seconds,spans.data![0].active_seconds);
    const corrected=await time('correct',{spanId:spans.data![0].id,expectedVersion:spans.data![0].version,
      startedAt:spans.data![0].started_at,endedAt:spans.data![0].started_at,reason:'HTTP accidental start correction'});
    assert.ifError(corrected.error);assert.equal(corrected.data.span.active_seconds,0);
    assert.deepEqual((await technician.from('task_timers').select('*').eq('id',paused.data.timer.id)).data,[]);
    assert.deepEqual((await technician.from('task_time_spans').select('*').eq('timer_id',paused.data.timer.id)).data,[]);
    const review=await owner.rpc('workshop_delivery_checklist',{order_id:operationId});
    assert.ifError(review.error);assert.equal(review.data.pendingCosts,2);
    const deliveryPayload={orderId:operationId,expectedVersion:review.data.version,recipient:'Synthetic customer',
      evidence:'HTTP receipt acknowledged',acknowledgePendingReception:true};
    assert.equal((await owner.rpc('deliver_workshop_order',{payload:deliveryPayload,idempotency_key:crypto.randomUUID()})).error?.message,'DELIVERY_HAS_PENDING_ITEMS');
    const deliveryKey=crypto.randomUUID();const authorizedDelivery={...deliveryPayload,exception:true,
      reason:'Owner authorizes delivery while classification is reviewed',creditReason:'Owner authorizes synthetic customer credit'};
    const delivered=await Promise.all([1,2].map(()=>owner.rpc('deliver_workshop_order',{payload:authorizedDelivery,idempotency_key:deliveryKey})));
    delivered.forEach(response=>assert.ifError(response.error));
    assert.equal(delivered[0].data.id,delivered[1].data.id);assert.equal(delivered[0].data.responsible_id,sessionData.session.user.id);
    assert.equal(delivered[0].data.checklist.pendingCosts,2);
    assert.equal((await owner.from('work_orders').select('status,estimate').eq('id',operationId)).data?.[0].status,'Entregado');
    assert.equal((await owner.from('work_orders').select('estimate').eq('id',operationId)).data?.[0].estimate,333.33);
    assert.deepEqual((await technician.from('workshop_deliveries').select('*').eq('order_id',operationId)).data,[]);
    const late=await owner.rpc('execute_delivery_cost_adjustment',{command:'purchase',idempotency_key:crypto.randomUUID(),
      payload:{...purchasePayload,description:'Late HTTP invoice',sourceReference:'late-invoice/line-1',reason:'Supplier sent invoice after vehicle delivery'}});
    assert.ifError(late.error);assert.equal(late.data.disposition,'Pendiente');
    const resolvedLate=await owner.rpc('execute_delivery_cost_adjustment',{command:'classify',idempotency_key:crypto.randomUUID(),
      payload:{costId:late.data.id,expectedVersion:late.data.version,disposition:'Absorbido',reason:'Owner accepted late warranty cost'}});
    assert.ifError(resolvedLate.error);
    assert.equal((await owner.from('workshop_deliveries').select('checklist').eq('id',delivered[0].data.id)).data?.[0].checklist.pendingCosts,2);
    await browserClient.auth.signOut({scope:'local'});
    await fresh.auth.signOut({scope:'local'});
  } finally {
    await owner.auth.signOut({scope:'local'});
    await technician.auth.signOut({scope:'local'});
  }
});
