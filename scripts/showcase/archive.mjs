import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,copyFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {DATABASE,SOURCE_CONTAINER,ROOT,LABEL,services,assertDatabase,grantAuthHelpers,digest,docker,readJson,saveJson} from './environment.mjs';

function binary(args,input){return execFileSync('docker',args,{input,timeout:120000,maxBuffer:100000000,stdio:['pipe','pipe','pipe']});}
function withContainerArchive(path,action){
  const target=`/tmp/aj-showcase-${randomUUID()}.dump`;
  try{
    docker(['cp',resolve(path),`${SOURCE_CONTAINER}:${target}`]);
    return action(target);
  }finally{docker(['exec',SOURCE_CONTAINER,'rm','-f','--',target]);}
}
export function validateArchive(bytes,metadata,journal){
  if(bytes.subarray(0,5).toString()!=='PGDMP'||metadata.database!==DATABASE||metadata.label!==LABEL||
    metadata.sha256!==digest(bytes)||journal.label!==LABEL||!journal.complete||journal.manifest?.workspace!==LABEL||
    (metadata.journalSha256&&metadata.journalSha256!==digest(JSON.stringify(journal))))throw new Error('SHOWCASE_ARCHIVE_MISMATCH');
}
export function archiveBaseline(){
  if(existsSync(`${ROOT}/baseline.dump`)){
    validateArchive(readFileSync(`${ROOT}/baseline.dump`),readJson(`${ROOT}/baseline.json`),readJson(`${ROOT}/baseline-journal.json`));
    return;
  }
  assertDatabase();if(!readJson(`${ROOT}/journal.json`).complete)throw new Error('SHOWCASE_NOT_COMPLETE');
  const bytes=binary(['exec',SOURCE_CONTAINER,'pg_dump','-U','supabase_admin','-d',DATABASE,'-Fc']);
  if(bytes.subarray(0,5).toString()!=='PGDMP')throw new Error('SHOWCASE_ARCHIVE_INVALID');
  // pg_restore --list can exit after the TOC without consuming all stdin. A large
  // synchronous input pipe then races with EOF on Windows; inspect a real file.
  const candidate=`${ROOT}/archive-${randomUUID()}.dump`;
  writeFileSync(candidate,bytes,{flag:'wx',mode:0o600});
  try{withContainerArchive(candidate,target=>docker(['exec',SOURCE_CONTAINER,'pg_restore','--list',target]));}
  finally{unlinkSync(candidate);}
  writeFileSync(`${ROOT}/baseline.dump`,bytes,{flag:'wx',mode:0o600});
  saveJson(`${ROOT}/baseline.json`,{database:DATABASE,label:LABEL,sha256:digest(bytes),
    journalSha256:digest(JSON.stringify(readJson(`${ROOT}/journal.json`))),createdAt:new Date().toISOString()});
  copyFileSync(`${ROOT}/journal.json`,`${ROOT}/baseline-journal.json`,1);
}
export function restoreBaseline(confirmation){
  if(confirmation!=='--confirm-showcase-only')throw new Error('SHOWCASE_RESTORE_REQUIRES_EXPLICIT_CONFIRMATION');
  assertDatabase();const metadata=readJson(`${ROOT}/baseline.json`);const bytes=readFileSync(`${ROOT}/baseline.dump`);
  validateArchive(bytes,metadata,readJson(`${ROOT}/baseline-journal.json`));
  withContainerArchive(`${ROOT}/baseline.dump`,target=>{
    docker(['exec',SOURCE_CONTAINER,'pg_restore','--list',target]);
    for(const name of services){const c=JSON.parse(docker(['inspect',name]))[0];if(c.Config.Labels?.['com.aj.workspace']!==LABEL)throw new Error('SHOWCASE_CONTAINER_MISMATCH');}
    const stopped=[];
    try{
      for(const name of services){docker(['stop','--time','15',name]);stopped.push(name);}
      binary(['exec',SOURCE_CONTAINER,'pg_restore','-U','supabase_admin','-d',DATABASE,'--clean','--if-exists','--exit-on-error','--single-transaction',target]);
      grantAuthHelpers();
      writeFileSync(`${ROOT}/journal.json`,readFileSync(`${ROOT}/baseline-journal.json`),{mode:0o600});
      saveJson(`${ROOT}/manifest.json`,readJson(`${ROOT}/journal.json`).manifest);
    }finally{for(const name of stopped)docker(['start',name]);}
  });
}
