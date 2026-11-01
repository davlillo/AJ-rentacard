import {readFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';

const mailpit='http://127.0.0.1:55324';
export async function dispatchDueReports(client,runDate=new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'})){
  async function command(command,payload){
    const {data,error}=await client.rpc('execute_report_delivery_command',{command,payload,idempotency_key:crypto.randomUUID()});
    if(error)throw new Error('Report worker database command failed.');return data;
  }
  await command('prepare',{runDate});
  const pending=await client.from('report_outbox').select('id').eq('state','Pendiente').order('created_at').limit(50);
  if(pending.error)throw new Error('Report worker could not read pending jobs.');
  let sent=0;
  for(const row of pending.data){
    const job=await command('claim',{jobId:row.id});if(!job)continue;
    // Mailpit captures mail locally. This worker never sends to an external mail provider.
    let response;
    try{
      response=await fetch(mailpit+'/api/v1/send',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({From:{Email:'reports@aj.local',Name:'AJ Reports'},To:[{Email:job.recipient_email}],
          Subject:`AJ report / ${job.cutoff} / ${job.snapshot.plate}`,
          Text:`Operational report. Not net profit or a fiscal statement.\nFilters: ${JSON.stringify(job.filters)}\n\n${JSON.stringify(job.snapshot,null,2)}`,
          Headers:{'Message-ID':`<${job.message_id}>`,'X-AJ-Outbox':job.id},Tags:['aj-report',job.id]}),signal:AbortSignal.timeout(15000)});
    }catch{
      await command('uncertain',{jobId:job.id,detail:'Transport outcome unknown; inspect local mailbox before any manual recovery.'});continue;
    }
    if(!response.ok){await command(response.status>=500?'uncertain':'failed',{jobId:job.id,detail:`Local capture rejected or could not confirm delivery: HTTP ${response.status}`});continue;}
    const acknowledgment=await response.json().catch(()=>null);
    if(!acknowledgment?.ID){await command('uncertain',{jobId:job.id,detail:'Local capture response lacked its message ID.'});continue;}
    await command('sent',{jobId:job.id,detail:`Mailpit local capture ID: ${acknowledgment.ID}`});sent++;
  }
  return{sent};
}

async function main(){
  const config=Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(line=>line&&!line.startsWith('#')&&line.includes('='))
    .map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  if(config.NEXT_PUBLIC_SUPABASE_URL!=='http://127.0.0.1:55321')throw new Error('Report worker is limited to AJ local.');
  const client=createClient(config.NEXT_PUBLIC_SUPABASE_URL,config.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:true}});
  const login=await client.auth.signInWithPassword({email:config.AJ_LOCAL_OWNER_EMAIL,password:config.AJ_LOCAL_OWNER_PASSWORD});
  if(login.error)throw new Error('Local report worker could not authenticate.');
  const tick=async()=>{const {sent}=await dispatchDueReports(client);console.log(`Local report cycle complete: ${sent} captured message(s).`);};
  await tick();
  if(process.argv.includes('--once')){await client.auth.signOut({scope:'local'});return;}
  let running=false;
  setInterval(()=>{if(running)return;running=true;void tick().catch(()=>console.error('Local report cycle failed; no payload or credentials logged.')).finally(()=>{running=false;});},60000);
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/report-worker.mjs')){
  main().catch(()=>{console.error('Local report worker failed. Verify AJ database, owner configuration and Mailpit.');process.exitCode=1;});
}
