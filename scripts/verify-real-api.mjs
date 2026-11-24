import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';

const config=Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(line=>line&&!line.startsWith('#')&&line.includes('='))
  .map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
if(config.NEXT_PUBLIC_SUPABASE_URL!=='http://127.0.0.1:55321')throw new Error('AJ loopback API required.');
const options={auth:{persistSession:false,autoRefreshToken:false}};
const key=config.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if(!key)throw new Error('AJ publishable API key required.');
const client=createClient(config.NEXT_PUBLIC_SUPABASE_URL,key,options);
const anonymous=createClient(config.NEXT_PUBLIC_SUPABASE_URL,key,options);
const {error:loginError}=await client.auth.signInWithPassword({email:config.AJ_LOCAL_OWNER_EMAIL,password:config.AJ_LOCAL_OWNER_PASSWORD});
if(loginError)throw new Error('Local Auth failed: '+(loginError.code??'connection'));
async function counts(){
  const result={};
  for(const table of ['customers','vehicles','work_orders','estimate_versions','expenses','workshop_costs','billing_documents','customer_payments','receipt_operation_contexts']){
    const {count,error}=await client.from(table).select('id',{count:'exact',head:true});
    if(error||count===null)throw new Error('Authorized count failed for '+table);result[table]=count;
  }return result;
}
const before=await counts();
const quote=await client.rpc('save_workshop_quote',{payload:{},idempotency_key:randomUUID()});
if(quote.error?.message!=='VEHICLE_NOT_FOUND')throw new Error('Quote endpoint/grant/validation mismatch.');
const details=await client.rpc('save_registry_details',{kind:'customer',payload:{},idempotency_key:randomUUID()});
if(details.error?.message!=='DETAILS_REASON_REQUIRED')throw new Error('Registry endpoint/grant/validation mismatch.');
const denied=await anonymous.rpc('save_workshop_quote',{payload:{},idempotency_key:randomUUID()});
if(denied.error?.code!=='42501')throw new Error('Anonymous quote execution must be denied.');
const connected=['record_linked_expense','link_workshop_expense','record_linked_receipt','record_connected_quote'];
for(const name of connected){
  const result=await client.rpc(name,{payload:{},idempotency_key:null});
  if(result.error?.message!=='INVALID_REQUEST')throw new Error('Connected endpoint/grant/validation mismatch: '+name);
  const blocked=await anonymous.rpc(name,{payload:{},idempotency_key:null});
  if(blocked.error?.code!=='42501')throw new Error('Anonymous connected endpoint must be denied: '+name);
}
if((await client.rpc('workshop_expense_inbox')).error)throw new Error('Authorized expense inbox read failed.');
if((await anonymous.rpc('workshop_expense_inbox')).error?.code!=='42501')throw new Error('Anonymous expense inbox must be denied.');
const {data:books,error:bookError}=await client.from('source_workbooks').select('id,file_name,file_hash');
if(bookError||books.length!==4)throw new Error('Four authorized originals required.');
const allowed=new Set(readdirSync('docs/excels'));
for(const book of books){
  if(!allowed.has(book.file_name))throw new Error('Unexpected original file name.');
  const {data:original,error}=await client.rpc('source_workbook_original',{workbook_id:book.id});
  if(error)throw new Error('Original download authorization failed.');
  const bytes=Buffer.from(original.base64,'base64');
  if(createHash('sha256').update(bytes).digest('hex')!==book.file_hash||!bytes.equals(readFileSync('docs/excels/'+book.file_name)))
    throw new Error('Authorized original is not byte-identical.');
}
const after=await counts();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Read-only API check changed business counts.');
const path='test-results/real-api-verification-'+Date.now()+'.json';
writeFileSync(path,JSON.stringify({verifiedAt:new Date().toISOString(),auth:true,quoteEndpoint:true,registryEndpoint:true,
  connectedMoneyEndpoints:connected.length,anonymousDenied:true,byteIdenticalOriginals:4,noBusinessWrites:true,counts:after},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({passed:true,auth:true,quoteEndpoint:true,registryEndpoint:true,connectedMoneyEndpoints:connected.length,anonymousDenied:true,byteIdenticalOriginals:4,noBusinessWrites:true,manifest:path}));
