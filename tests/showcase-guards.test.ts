import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertTarget,DATABASE,API,APP,LABEL,digest} from '../scripts/showcase/environment.mjs';
import {canEnterDemo} from '../scripts/showcase/gateway.mjs';
import {restoreBaseline,validateArchive} from '../scripts/showcase/archive.mjs';

test('Showcase provisioning and restoration never accept a configurable production database',()=>{
  assert.equal(DATABASE,'aj_showcase');assert.equal(API,'http://127.0.0.1:56321');assert.equal(APP,'http://127.0.0.1:3040');
  assert.doesNotThrow(()=>assertTarget('aj_showcase'));
  for(const target of ['postgres','aj-rentacar','postgresql://remote/database',''])assert.throws(()=>assertTarget(target),/SHOWCASE_DATABASE_REQUIRED/);
  assert.throws(()=>restoreBaseline(''),/EXPLICIT_CONFIRMATION/);
  const source=readFileSync('scripts/showcase/environment.mjs','utf8');
  assert.ok(source.includes('begin read only;'));assert.ok(source.includes('SHOWCASE_DATABASE_MARKER_REQUIRED'));
  assert.ok(!source.includes('drop database'));assert.ok(!source.includes('ALTER ROLE'));
  assert.ok(source.includes('grant execute on function auth.uid(),auth.jwt(),auth.role(),auth.email()'));
  const archive=readFileSync('scripts/showcase/archive.mjs','utf8');
  assert.ok(archive.includes('grantAuthHelpers();'));
  assert.ok(!archive.includes("'pg_restore','--list'],bytes"));
});
test('The operational interface does not add environment banners or a presentation walkthrough',()=>{
  const shell=readFileSync('src/components/templates/operational-shell.tsx','utf8');
  const access=readFileSync('src/components/organisms/showcase-access.tsx','utf8');
  const login=readFileSync('src/components/organisms/session-form.tsx','utf8');
  assert.ok(!shell.includes('ShowcaseGuide'));
  assert.ok(!/datos ficticios|demostraci[oó]n/i.test(access+login));
  assert.ok(access.includes('Ingresar<ArrowRight'));
});
test('Showcase restore rejects changed archives and incomplete or foreign journals before stopping any service',()=>{
  const bytes=Buffer.from('PGDMP-test');const journal={label:LABEL,complete:true,manifest:{workspace:LABEL}};
  const metadata={database:DATABASE,label:LABEL,sha256:digest(bytes),journalSha256:digest(JSON.stringify(journal))};
  assert.doesNotThrow(()=>validateArchive(bytes,metadata,journal));
  assert.throws(()=>validateArchive(Buffer.from('PGDMP-changed'),metadata,journal),/ARCHIVE_MISMATCH/);
  assert.throws(()=>validateArchive(bytes,{...metadata,database:'postgres'},journal),/ARCHIVE_MISMATCH/);
  assert.throws(()=>validateArchive(bytes,metadata,{...journal,complete:false}),/ARCHIVE_MISMATCH/);
  assert.throws(()=>validateArchive(bytes,metadata,{...journal,label:'another-workspace'}),/ARCHIVE_MISMATCH/);
});
test('The presentation sign-in helper is a local POST, not a cross-site login or a public credential endpoint',()=>{
  assert.equal(canEnterDemo('POST',APP,'same-site'),true);
  assert.equal(canEnterDemo('POST','http://localhost:3040','same-origin'),true);
  assert.equal(canEnterDemo('GET',APP,'same-site'),false);
  assert.equal(canEnterDemo('POST','http://127.0.0.1:3030','same-site'),false);
  assert.equal(canEnterDemo('POST','https://example.com','cross-site'),false);
  assert.equal(canEnterDemo('POST',undefined,undefined),false);
  const gate=readFileSync('src/lib/showcase.ts','utf8');
  assert.ok(gate.includes("NEXT_PUBLIC_SHOWCASE==='true'"));assert.ok(gate.includes('http://127.0.0.1:56321'));
  const form=readFileSync('src/components/organisms/showcase-access.tsx','utf8');
  assert.ok(form.includes('auth.setSession'));assert.ok(!/NEXT_PUBLIC_.*PASSWORD|service_role|ownerPassword/.test(form));
});
