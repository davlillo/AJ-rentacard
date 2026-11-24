import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';

export const DATABASE='aj_showcase';
export const SOURCE_CONTAINER='supabase_db_aj-rentacar';
export const ROOT='test-results/showcase';
export const API='http://127.0.0.1:56321';
export const APP='http://127.0.0.1:3040';
export const AUTH='http://127.0.0.1:56324';
export const REST='http://127.0.0.1:56323';
export const LABEL='aj-rentacar-showcase-v1';
export const services=['aj_showcase_auth','aj_showcase_rest'];
const marker='AJ Rentacar isolated showcase; synthetic data only; v1';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
export function saveJson(path,value){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});}

export function docker(args,input){
  return execFileSync('docker',args,{input,encoding:'utf8',timeout:120000,maxBuffer:100000000,stdio:['pipe','pipe','pipe']}).trim();
}
function psql(database,input){return docker(['exec','-i',SOURCE_CONTAINER,'psql','-U',database===DATABASE?'supabase_admin':'postgres','-d',database,'-Atq','-v','ON_ERROR_STOP=1'],input);}
export function originalRead(query){return psql('postgres',`begin read only;\n${query}\ncommit;`);}
export function assertTarget(database){if(database!==DATABASE)throw new Error('SHOWCASE_DATABASE_REQUIRED');}
export function assertWorkspace(){
  if(!readFileSync('supabase/config.toml','utf8').includes('project_id = "aj-rentacar"'))throw new Error('AJ_REPOSITORY_REQUIRED');
}
export function assertDatabase(){
  const found=originalRead(`select coalesce(shobj_description(oid,'pg_database'),'') from pg_database where datname='${DATABASE}';`);
  if(found!==marker)throw new Error('SHOWCASE_DATABASE_MARKER_REQUIRED');
}
export function showcaseSql(query){assertDatabase();return psql(DATABASE,`set search_path=public,extensions;\n${query}`);}
export function grantAuthHelpers(){
  // Explicit ACLs survive restores even after application migrations revoke
  // default PUBLIC execution. Task RLS calls auth.uid() as the authenticated role.
  showcaseSql('grant execute on function auth.uid(),auth.jwt(),auth.role(),auth.email() to anon,authenticated,service_role;');
}

export function snapshotOriginal(){
  const tables=JSON.parse(originalRead("select jsonb_agg(jsonb_build_object('schema',schemaname,'table',tablename) order by schemaname,tablename) from pg_tables where schemaname='public' or (schemaname='auth' and tablename in ('users','identities'));"));
  if(tables.some(t=>!/^\w+$/.test(t.schema)||!/^\w+$/.test(t.table)))throw new Error('UNEXPECTED_SOURCE_IDENTIFIER');
  const records=JSON.parse(originalRead(`select jsonb_object_agg(name,jsonb_build_object('count',rows,'hash',hash)) from (${tables.map(t=>
    `select '${t.schema}.${t.table}' name,count(*) rows,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) hash from "${t.schema}"."${t.table}" t`).join(' union all ')}) s;`));
  const files=Object.fromEntries(['.env.local',...readdirSync('docs/excels').filter(f=>/\.xlsx$/i.test(f)).map(f=>'docs/excels/'+f)]
    .map(path=>[path,digest(readFileSync(path))]));
  return{checkedAt:new Date().toISOString(),tables:records,files};
}
export function verifyOriginal(config){
  const before=readJson(config.sourceSnapshot);const after=snapshotOriginal();
  const changed=Object.keys(before.tables).filter(key=>JSON.stringify(before.tables[key])!==JSON.stringify(after.tables[key]));
  const filesChanged=Object.keys(before.files).filter(key=>before.files[key]!==after.files[key]);
  saveJson(`${ROOT}/original-verification.json`,{checkedAt:after.checkedAt,unchanged:!changed.length&&!filesChanged.length,changed,filesChanged,after});
  if(changed.length||filesChanged.length)throw new Error('ORIGINAL_CHANGED_REVIEW_REQUIRED');
  return{unchanged:true,tables:Object.keys(before.tables).length,files:Object.keys(before.files).length};
}
function jwt(secret,role){
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const now=Math.floor(Date.now()/1000);const body=encode({alg:'HS256',typ:'JWT'})+'.'+encode({iss:'aj-showcase',role,iat:now,exp:now+31536000});
  return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
}
export function configuration(){
  assertWorkspace();mkdirSync(ROOT,{recursive:true});const path=`${ROOT}/private.json`;
  if(existsSync(path)){const config=readJson(path);if(config.database!==DATABASE||config.api!==API||config.label!==LABEL)throw new Error('SHOWCASE_CONFIG_MISMATCH');return config;}
  const secret=randomBytes(48).toString('hex');const sourceSnapshot=`${ROOT}/original-before-setup-${Date.now()}.json`;
  saveJson(sourceSnapshot,snapshotOriginal());
  const config={database:DATABASE,api:API,label:LABEL,secret,anon:jwt(secret,'anon'),service:jwt(secret,'service_role'),
    ownerEmail:'presentation@aj-showcase.example',ownerPassword:randomBytes(24).toString('base64url'),
    mechanicEmail:'mechanic@aj-showcase.example',mechanicPassword:randomBytes(24).toString('base64url'),
    painterEmail:'painter@aj-showcase.example',painterPassword:randomBytes(24).toString('base64url'),sourceSnapshot};
  saveJson(path,config);
  writeFileSync('.env.showcase.local',[
    '# Isolated local showcase only. Original .env.local remains untouched. Never commit this file.',
    'NEXT_PUBLIC_DATA_SOURCE=supabase','NEXT_PUBLIC_SHOWCASE=true',`NEXT_PUBLIC_SUPABASE_URL=${API}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${config.anon}`,`SHOWCASE_OWNER_EMAIL=${config.ownerEmail}`,
    `SHOWCASE_OWNER_PASSWORD=${config.ownerPassword}`,'',
  ].join('\n'),{flag:'wx',mode:0o600});
  return config;
}
function inspect(name){return JSON.parse(docker(['inspect',name]))[0];}
function environment(container){return Object.fromEntries(container.Config.Env.map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));}
export function ensureDatabase(){
  const exists=originalRead(`select count(*) from pg_database where datname='${DATABASE}';`)==='1';
  if(!exists){psql('postgres',`create database ${DATABASE} template template0;\ncomment on database ${DATABASE} is '${marker}';`);}
  assertDatabase();
  psql(DATABASE,`create schema if not exists extensions;create extension if not exists pgcrypto with schema extensions;
    create schema if not exists auth authorization supabase_auth_admin;
    grant create on database ${DATABASE} to supabase_auth_admin;
    grant usage on schema public,extensions,auth to anon,authenticated,service_role;
    grant all on schema public to postgres;`);
}
export function startServices(config){
  assertDatabase();const auth=inspect('supabase_auth_aj-rentacar');const rest=inspect('supabase_rest_aj-rentacar');
  const authUrl=new URL(environment(auth).GOTRUE_DB_DATABASE_URL);authUrl.pathname='/'+DATABASE;
  const restUrl=new URL(environment(rest).PGRST_DB_URI);restUrl.pathname='/'+DATABASE;
  const envs=[{
    API_EXTERNAL_URL:API+'/auth/v1',GOTRUE_API_HOST:'0.0.0.0',GOTRUE_API_PORT:'9999',GOTRUE_DB_DRIVER:'postgres',
    GOTRUE_DB_DATABASE_URL:authUrl.href,GOTRUE_DB_NAMESPACE:'auth',GOTRUE_DB_MAX_POOL_SIZE:'4',GOTRUE_SITE_URL:APP,
    GOTRUE_URI_ALLOW_LIST:APP,GOTRUE_DISABLE_SIGNUP:'true',GOTRUE_JWT_ADMIN_ROLES:'service_role',GOTRUE_JWT_AUD:'authenticated',
    GOTRUE_JWT_DEFAULT_GROUP_NAME:'authenticated',GOTRUE_JWT_EXP:'3600',GOTRUE_JWT_SECRET:config.secret,
    GOTRUE_JWT_ISSUER:API+'/auth/v1',GOTRUE_EXTERNAL_EMAIL_ENABLED:'true',GOTRUE_MAILER_AUTOCONFIRM:'true',
    GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED:'false',GOTRUE_EXTERNAL_PHONE_ENABLED:'false',GOTRUE_PASSWORD_MIN_LENGTH:'12',
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED:'true',GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL:'10',
  },{
    PGRST_DB_URI:restUrl.href,PGRST_DB_SCHEMAS:'public',PGRST_DB_EXTRA_SEARCH_PATH:'public,extensions',PGRST_DB_MAX_ROWS:'1000',
    PGRST_DB_ANON_ROLE:'anon',PGRST_DB_POOL:'4',PGRST_JWT_SECRET:config.secret,PGRST_DB_CONFIG:'false',PGRST_SERVER_PORT:'3000',
  }];
  for(let i=0;i<services.length;i++){
    const path=`${ROOT}/${i===0?'auth':'rest'}.env`;
    writeFileSync(path,Object.entries(envs[i]).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600});
    const check=spawnSync('docker',['inspect',services[i]],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    if(check.status===0){
      const current=JSON.parse(check.stdout)[0];
      if(current.Config.Labels?.['com.aj.workspace']!==LABEL||environment(current)[i===0?'GOTRUE_DB_DATABASE_URL':'PGRST_DB_URI']!==[authUrl.href,restUrl.href][i])throw new Error('SHOWCASE_CONTAINER_MISMATCH');
      if(!current.State.Running)docker(['start',services[i]]);
    }else docker(['run','--detach','--pull','never','--name',services[i],'--label',`com.aj.workspace=${LABEL}`,
      '--network','aj-rentacar-loopback','--publish',`127.0.0.1:${i===0?56324:56323}:${i===0?9999:3000}`,
      '--env-file',path,[auth.Config.Image,rest.Config.Image][i]]);
  }
}
export async function waitFor(url,headers={}){
  for(let attempt=0;attempt<60;attempt++){
    try{const response=await fetch(url,{headers,signal:AbortSignal.timeout(3000)});if(response.ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('SHOWCASE_SERVICE_NOT_READY');
}
export function migrate(){
  const definitions=originalRead("select string_agg(pg_get_functiondef(p.oid)||';', E'\\n') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname in ('uid','jwt','role','email');");
  showcaseSql(`${definitions}\ngrant usage on schema auth to anon,authenticated,service_role;
    create schema if not exists private;
    create table if not exists private.showcase_migrations(version text primary key,hash text not null);
    create table if not exists private.showcase_environment(id text primary key,manifest jsonb,created_at timestamptz default now());
    insert into private.showcase_environment(id) values('${LABEL}') on conflict do nothing;`);
  const applied=new Map(JSON.parse(showcaseSql("select coalesce(jsonb_agg(jsonb_build_array(version,hash)),'[]') from private.showcase_migrations;")));
  for(const file of readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql')).sort()){
    const text=readFileSync('supabase/migrations/'+file,'utf8');const hash=digest(text);
    if(applied.has(file)){if(applied.get(file)!==hash)throw new Error('APPLIED_SHOWCASE_MIGRATION_CHANGED');continue;}
    showcaseSql(`begin;\n${text}\ninsert into private.showcase_migrations values('${file}','${hash}');\ncommit;`);
  }
  grantAuthHelpers();showcaseSql("notify pgrst,'reload schema';");
}
