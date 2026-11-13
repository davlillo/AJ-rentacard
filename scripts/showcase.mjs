import {createClient} from '@supabase/supabase-js';
import {spawn} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {configuration,ensureDatabase,startServices,waitFor,migrate,verifyOriginal,readJson,saveJson,
  API,APP,AUTH,ROOT,LABEL,DATABASE} from './showcase/environment.mjs';
import {createGateway} from './showcase/gateway.mjs';
import {provisionUsers,seedScenario} from './showcase/scenario.mjs';
import {archiveBaseline,restoreBaseline} from './showcase/archive.mjs';
import {prepareImages} from './showcase/prepare-images.mjs';
import {paymentAvailable} from '../src/controladores/linked-money.ts';

async function checkDemo(config,strict=true){
  const manifest=readJson(`${ROOT}/manifest.json`);
  const client=createClient(API,config.anon,{auth:{persistSession:false,autoRefreshToken:false}});
  if((await client.auth.signInWithPassword({email:config.ownerEmail,password:config.ownerPassword})).error)throw new Error('SHOWCASE_LOGIN_FAILED');
  const rows=async table=>{const result=await client.from(table).select('*');if(result.error)throw new Error('SHOWCASE_READ_FAILED '+table);return result.data;};
  const [cars,reservations,jobs,files,tasks,charges,payments,applications,refunds]=await Promise.all([
    'vehicles','reservations','work_orders','vehicle_files','workshop_tasks','billing_documents','customer_payments','payment_applications','payment_refunds'].map(rows));
  const fleet=cars.filter(c=>c.in_rental_fleet);
  const reserved=fleet.filter(c=>c.status==='Disponible'&&reservations.some(r=>r.vehicle_id===c.id&&r.status==='Confirmada'&&r.rental_state==='Preparado'&&Date.parse(r.ends_at)>Date.now())).length;
  const counts={fleet:fleet.length,available:fleet.filter(c=>c.status==='Disponible').length-reserved,rented:fleet.filter(c=>c.status==='Alquilado').length,reserved,
    workshop:jobs.filter(j=>j.status!=='Entregado').length,closedFolios:jobs.filter(j=>j.status==='Entregado').length,vehiclePhotos:cars.filter(c=>files.some(f=>f.vehicle_id===c.id&&f.purpose==='Vehículo')).length};
  const countsMatch=cars.length===7&&counts.closedFolios===3&&counts.vehiclePhotos===7&&
    ['fleet','available','rented','reserved','workshop'].every(key=>counts[key]===manifest.expected[key]);
  if(strict&&!countsMatch)throw new Error('SHOWCASE_COUNT_MISMATCH');
  const diary=await client.rpc('cash_diary',{from_date:manifest.today,to_date:manifest.today,account_filter:'Caja DEMO'});
  const billing=await client.rpc('receivables_at',{cutoff:manifest.today});
  if(diary.error||billing.error)throw new Error('SHOWCASE_FINANCIAL_READ_FAILED');
  const balance=billing.data.reduce((sum,d)=>sum+Number(d.balance),0);
  const advances=payments.reduce((sum,p)=>sum+paymentAvailable(p,applications,refunds),0);
  const charged=charges.reduce((sum,d)=>sum+Number(d.amount),0);
  const moneyMatch=diary.data.income===manifest.expected.receipts&&diary.data.outgoing===manifest.expected.expenses&&balance===manifest.expected.balance&&
    charged===manifest.expected.charges&&advances===manifest.expected.advances&&diary.data.netMovement===manifest.expected.cashNet&&
    diary.data.balanceAfter===manifest.expected.opening+manifest.expected.cashNet;
  if(strict&&!moneyMatch)throw new Error('SHOWCASE_MONEY_MISMATCH');
  const anonymous=createClient(API,config.anon,{auth:{persistSession:false,autoRefreshToken:false}});
  if((await anonymous.rpc('cash_diary',{from_date:manifest.today,to_date:manifest.today})).error?.code!=='42501')throw new Error('SHOWCASE_ANONYMOUS_ACCESS_NOT_DENIED');
  const original=verifyOriginal(config);
  const result={passed:true,baselineMatch:countsMatch&&moneyMatch,checkedAt:new Date().toISOString(),counts,authorizedTaskRead:tasks.length,
    money:{charged,income:diary.data.income,outgoing:diary.data.outgoing,balance,advances,net:diary.data.netMovement,cashBalance:diary.data.balanceAfter},anonymousDenied:true,original};
  saveJson(`${ROOT}/verification.json`,result);return result;
}
async function main(){
  const mode=process.argv[2]??'dev';
  if(!['setup','dev','verify','restore'].includes(mode))throw new Error('SHOWCASE_MODE_REQUIRED');
  const config=configuration();let gateway;
  let running=false;
  try{const response=await fetch(API+'/showcase/health',{signal:AbortSignal.timeout(2000)});const health=await response.json();
    if(health.workspace!==LABEL||health.database!==DATABASE)throw new Error('SHOWCASE_GATEWAY_MISMATCH');running=true;
  }catch(error){if(error.message==='SHOWCASE_GATEWAY_MISMATCH')throw error;}
  if(!running){gateway=createGateway(config);await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(56321,'127.0.0.1',resolve);});}
  try{
    if(mode==='restore'){
      restoreBaseline(process.argv[3]);await waitFor(AUTH+'/health');
      await waitFor(API+'/rest/v1/',{apikey:config.anon,Authorization:'Bearer '+config.anon});
    }else if(mode!=='verify'){
      if(!existsSync(`${ROOT}/journal.json`)||!readJson(`${ROOT}/journal.json`).complete)prepareImages();
      ensureDatabase();startServices(config);await waitFor(AUTH+'/health');migrate();
      await waitFor(API+'/rest/v1/',{apikey:config.anon,Authorization:'Bearer '+config.anon});
      const users=await provisionUsers(config);const manifest=await seedScenario(config,users);
      console.log(JSON.stringify({showcaseReady:true,database:DATABASE,vehicles:manifest.vehicles.length,api:API}));
    }
    const check=await checkDemo(config,mode!=='dev');console.log(JSON.stringify(check));archiveBaseline();
    if(mode==='dev'){
      const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3040'],{
        stdio:'inherit',env:{...process.env,AJ_SHOWCASE:'1',NEXT_PUBLIC_DATA_SOURCE:'supabase',NEXT_PUBLIC_SHOWCASE:'true',
          NEXT_PUBLIC_SUPABASE_URL:API,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:config.anon},});
      console.log('Local demonstration: '+APP+' · original workspace configuration unchanged.');
      const stop=()=>{child.kill();gateway?.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
      await new Promise(resolve=>child.once('exit',resolve));
    }
  }finally{gateway?.close();}
}
main().catch(error=>{
  let detail=(error.stderr?.toString().trim()||error.message||String(error)).slice(0,12000)
    .replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/g,'$1[REDACTED]@');
  if(existsSync(`${ROOT}/private.json`))for(const value of Object.values(readJson(`${ROOT}/private.json`))){if(typeof value==='string'&&value.length>20)detail=detail.replaceAll(value,'[REDACTED]');}
  writeFileSync(`${ROOT}/last-error.txt`,detail,{mode:0o600});
  console.error('Showcase setup failed. See test-results/showcase/last-error.txt. Original records were not reset.');process.exitCode=1;
});
