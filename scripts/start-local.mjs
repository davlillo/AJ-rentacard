import {execFileSync, spawnSync} from 'node:child_process';

const network = 'aj-rentacar-loopback';
const inspection = spawnSync('docker',['network','inspect',network,'--format','{{json .Options}}'],
  {encoding:'utf8',timeout:15000});
try {
  if (inspection.status !== 0) {
    if (!inspection.stderr?.includes('not found') && !inspection.stderr?.includes('No such network')) {
      throw new Error('Docker is unavailable.');
    }
    execFileSync('docker',['network','create','--driver','bridge','--opt',
      'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',network],{stdio:'pipe',timeout:15000});
  } else if (JSON.parse(inspection.stdout)['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1') {
    throw new Error('AJ network has unsafe port bindings; it was not modified.');
  }
  execFileSync(process.execPath,['node_modules/supabase/dist/supabase.js','start','--ignore-health-check','--network-id',network,
    '-x','realtime,storage-api,imgproxy,logflare,vector,supavisor,studio,postgres-meta'],{stdio:'inherit'});
  // The CLI's short health window can expire while PostgREST loads its schema.
  // Do not report success merely because --ignore-health-check returned zero.
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:55321/rest-admin/v1/ready',
        {method:'HEAD',signal:AbortSignal.timeout(3000)});
      if (response.ok) {ready = true; break;}
    } catch {}
    await new Promise(resolve => setTimeout(resolve,2000));
  }
  if (!ready) throw new Error('AJ API readiness timed out; inspect only AJ containers.');
  console.log('AJ API is ready on http://127.0.0.1:55321.');
  // Docker Desktop may ignore bridge host_binding_ipv4; never infer exposure from the URL.
  const bindings = execFileSync('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',
    'supabase_kong_aj-rentacar','supabase_db_aj-rentacar'],{encoding:'utf8',timeout:15000});
  if (bindings.includes('0.0.0.0') || bindings.includes('"::"')) {
    console.warn('WARNING: Docker Desktop published AJ ports on all interfaces despite the loopback network option. Use a trusted local network only; never expose this development stack publicly.');
  }
} catch (error) {
  console.error('AJ local startup failed. Check Docker and the dedicated loopback network.');
  process.exitCode = 1;
}
