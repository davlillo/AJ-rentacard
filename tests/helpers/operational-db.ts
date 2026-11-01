import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';

export async function operationalDb(){
  const db=await PGlite.create({extensions:{btree_gist}});
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create table auth.users(id uuid primary key,email varchar(255));
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for(const file of readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql')).sort())
    await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'));
  const owner=crypto.randomUUID();const technician=crypto.randomUUID();
  for(const[id,role]of[[owner,'owner'],[technician,'technician']]){
    await db.query('insert into auth.users values($1,$2)',[id,role+'@local']);await db.query('insert into public.user_roles values($1,$2)',[id,role]);}
  async function asUser(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
  async function rpc<T=Record<string,unknown>>(fn:string,args:Record<string,unknown>):Promise<T>{
    const names=Object.keys(args);if(!/^[a-z_][a-z0-9_]*$/.test(fn)||names.some(name=>!/^[a-z_][a-z0-9_]*$/.test(name)))throw new Error('Unsafe test identifier');
    return(await db.query<{r:T}>(`select public.${fn}(${names.map((name,i)=>`${name}=>$${i+1}`).join(',')}) r`,Object.values(args))).rows[0].r;
  }
  async function command<T=Record<string,unknown>>(fn:string,command:string,payload:Record<string,unknown>,key=crypto.randomUUID()):Promise<T>{
    return rpc<T>(fn,{command,payload:JSON.stringify(payload),idempotency_key:key});
  }
  await asUser(owner);return{db,owner,technician,asUser,rpc,command};
}
