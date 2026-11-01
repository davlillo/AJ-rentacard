import {execFileSync} from 'node:child_process';
import {createClient} from '@supabase/supabase-js';
import {localStatus} from './setup-local.mjs';

const status=localStatus();
const client=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const email=`browser-technician-${crypto.randomUUID()}@aj.local`;
const password=crypto.randomUUID()+crypto.randomUUID();
const user=await client.auth.admin.createUser({email,password,email_confirm:true});
if(user.error||!user.data.user)throw new Error('Could not provision AJ synthetic technician.');
const role=await client.from('user_roles').insert({user_id:user.data.user.id,role:'technician'});
if(role.error)throw new Error('Could not assign synthetic technician role.');
try{
  const output=execFileSync('.venv/Scripts/python.exe',['tests/browser/role_access_acceptance.py'],{
    env:{...process.env,AJ_TEST_TECH_EMAIL:email,AJ_TEST_TECH_PASSWORD:password},encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
  process.stdout.write(output);
}catch{
  console.error('Technician browser permission acceptance failed. Credentials were not logged.');process.exitCode=1;
}
