import {test} from 'node:test';
import assert from 'node:assert/strict';

test('task responsibility validation, RPC acknowledgement and narrow legacy reads', async t => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:59999';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'synthetic-key-never-forwarded';
  let taskError: {code:string; message:string} | null = null;
  let rpcError: string | null = null;
  let acknowledgement = true;
  const calls: {resource:string; select:string; body:Record<string, unknown>|null}[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.host, '127.0.0.1:59999', 'No real endpoint may be contacted');
    const resource = url.pathname.split('/').at(-1)!;
    const select = url.searchParams.get('select') ?? '';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({resource, select, body});
    if (resource === 'execute_task_command') {
      return Response.json(rpcError ? {code:'P0001', message:rpcError} :
        {id:'synthetic-task', version:1, status:'Pendiente',
          ...(acknowledgement ? {responsibleNameSupported:true} : {})}, {status:rpcError ? 400 : 200});
    }
    if (resource === 'workshop_tasks') {
      if (select.includes('responsibleName:responsible_name') && taskError) {
        return Response.json(taskError, {status:400});
      }
      return Response.json([{id:'synthetic-task', assignedTo:'account-id', assigneeLabel:'Account label',
        ...(select.includes('responsibleName:responsible_name') ? {responsibleName:'Unlisted person'} : {})}]);
    }
    const records: Record<string, unknown[]> = {
      customers:[{id:'customer', name:'Customer preserved', merged_into:null}],
      customer_aliases:[], vehicles:[], work_orders:[{id:'order', service:'Order preserved'}],
      expenses:[], reservations:[], vehicle_files:[],
    };
    assert.ok(resource in records, `Unknown synthetic request: ${resource}`);
    return Response.json(records[resource]);
  };
  try {
    const {normalizeResponsibleName, executeTaskCommand, responsibleNameMigrationMessage} =
      await import('../src/lib/supabase/tasks');
    const {readWorkshopTasks, loadBusiness, isMissingResponsibleNameColumn} =
      await import('../src/lib/supabase/business');
    await t.test('optional names trim consistently without accepting non-text or overlong values', () => {
      assert.equal(normalizeResponsibleName(null), null);
      assert.equal(normalizeResponsibleName(' \t\n\r\v\f '), null);
      assert.equal(normalizeResponsibleName(' \tOutside person\n '), 'Outside person');
      assert.equal(normalizeResponsibleName('<script>not executable</script>'), '<script>not executable</script>');
      assert.equal(normalizeResponsibleName('x'.repeat(120)), 'x'.repeat(120));
      for (const value of [undefined, 42, {}, [], true, 'x'.repeat(121)]) {
        assert.throws(() => normalizeResponsibleName(value));
      }
    });
    await t.test('new metadata is aliased while legacy fallback preserves all other business data', async () => {
      assert.equal((await readWorkshopTasks()).tasks[0].responsibleName, 'Unlisted person');
      for (const code of ['42703', 'PGRST204']) {
        taskError = {code, message: code === '42703' ? 'column workshop_tasks.responsible_name does not exist' :
          "Could not find the 'responsible_name' column of 'workshop_tasks' in the schema cache"};
        calls.length = 0;
        const result = await loadBusiness();
        assert.equal(result.taskResponsibleNameAvailable, false);
        assert.equal(result.tasks?.[0].responsibleName, undefined);
        assert.equal(result.tasks?.[0].assignedTo, 'account-id');
        assert.equal(result.customers[0].name, 'Customer preserved');
        assert.equal(result.orders[0].service, 'Order preserved');
        const reads = calls.filter(call => call.resource === 'workshop_tasks');
        assert.equal(reads.length, 2);
        assert.ok(!reads[1].select.includes('responsibleName'));
      }
    });
    await t.test('authorization, network and unrelated schema failures never trigger fallback', async () => {
      for (const error of [
        {code:'42501', message:'permission denied for responsible_name column'},
        {code:'PGRST301', message:'JWT expired'},
        {code:'42703', message:'column workshop_tasks.some_other_column does not exist'},
        {code:'PGRST204', message:"Could not find the 'assigned_to' column"},
        {code:'NETWORK_ERROR', message:'responsible_name column unavailable'},
        {code:'42703', message:'column irresponsible_name does not exist'},
      ]) {
        assert.equal(isMissingResponsibleNameColumn(error), false);
        taskError = error;
        calls.length = 0;
        await assert.rejects(readWorkshopTasks(), /No se pudieron cargar/);
        assert.equal(calls.length, 1);
      }
      taskError = null;
    });
    await t.test('RPC retains the exact original payload and requires positive metadata acknowledgement', async () => {
      const payload = {orderId:'order', assignedTo:'account-id', description:'Work', responsibleName:'  Unlisted  '};
      await executeTaskCommand('create', payload, 'synthetic-key');
      assert.deepEqual(calls.at(-1)?.body, {command:'create', payload, idempotency_key:'synthetic-key'});
      acknowledgement = false;
      await assert.rejects(executeTaskCommand('create', payload, 'synthetic-key'), {
        message:responsibleNameMigrationMessage,
      });
      // Existing payloads remain supported by old servers without the new acknowledgement.
      await executeTaskCommand('create', {orderId:'order', assignedTo:'account-id'}, 'legacy-key');
      acknowledgement = true;
      for (const error of ['INVALID_RESPONSIBLE_NAME','RESPONSIBLE_NAME_MIGRATION_REQUIRED',
        'UNSUPPORTED_TASK_METADATA','PERMISSION_DENIED','VERSION_CONFLICT','TASK_HAS_OPEN_TIMER']) {
        rpcError = error;
        await assert.rejects(executeTaskCommand('assign', payload, 'synthetic-key'));
      }
      rpcError = null;
      const before = calls.length;
      await assert.rejects(executeTaskCommand('transition', {responsibleName:'Smuggled'}, 'bad-key'), /estado/);
      await assert.rejects(executeTaskCommand('assign', {responsibleName:{}}, 'bad-key'), /texto/);
      assert.equal(calls.length, before);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = originalKey;
  }
});
