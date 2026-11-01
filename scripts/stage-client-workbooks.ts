import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {localStatus} from './setup-local.mjs';
import {parseSourceWorkbook} from '../src/controladores/source-workbooks';

// Local-only evidence staging. Deliberately no call to review_source_item:
// this script can never publish the client's vehicles, charges or cash facts.
async function main():Promise<void>{
  const status=localStatus();
  const env=Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.startsWith('#'))
    .map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
  const client=createClient(status.API_URL,status.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const login=await client.auth.signInWithPassword({email:env.AJ_LOCAL_OWNER_EMAIL,password:env.AJ_LOCAL_OWNER_PASSWORD});
  if(login.error)throw new Error('Local owner authentication failed. Credentials were not printed.');
  async function counts():Promise<string>{
    return JSON.stringify(await Promise.all(['vehicles','expenses','customer_payments','billing_documents','reservations'].map(async table=>{
      const result=await client.from(table).select('id',{count:'exact',head:true});if(result.error)throw new Error(`Could not count ${table}`);
      return{table,count:result.count};
    })));
  }
  const before=await counts();
  for(const file of ['LIBRO DIARIO EJEMPLO MAYO 2026.xlsx','Ejemplo presupuesto taller.xlsx',
    'ejemplo calendario carros renta.xlsx','Ejemplo cuadro cuentas por cobrar.xlsx']){
    const bytes=readFileSync(`docs/excels/${file}`);
    const workbook=parseSourceWorkbook(file,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    const result=await client.rpc('stage_source_workbook',{payload:workbook,idempotency_key:crypto.randomUUID()});
    if(result.error)throw new Error(`Could not stage ${file}: ${result.error.message}`);
    if(result.data.file_hash!==createHash('sha256').update(bytes).digest('hex'))throw new Error('Original file hash mismatch');
    console.log(`Preserved original for review: ${file} (${workbook.items.length} observations; no financial publication)`);
  }
  if(before!==await counts())throw new Error('Unexpected business record change while staging evidence');
  console.log('Four originals are private and reviewable. Vehicle, cash, charge and reservation counts did not change.');
  await client.auth.signOut({scope:'local'});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
