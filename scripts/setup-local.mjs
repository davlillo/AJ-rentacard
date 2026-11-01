import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';

// Never print service keys or write them into a NEXT_PUBLIC variable.
export function localStatus() {
  const raw = execFileSync(process.execPath, ['node_modules/supabase/dist/supabase.js', 'status', '-o', 'json'],
    {encoding: 'utf8', timeout: 30000, stdio: ['ignore','pipe','pipe']});
  const status = JSON.parse(raw);
  if (status.API_URL !== 'http://127.0.0.1:55321') throw new Error('Refusing to provision a non-AJ local project.');
  return status;
}

async function main() {
  const status = localStatus();
  const auth = {persistSession: false, autoRefreshToken: false};
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {auth});
  const file = '.env.local';
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8');
    if (!existing.includes('NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321')) {
      throw new Error('An existing .env.local belongs to another configuration; it was not overwritten.');
    }
    if (process.argv.includes('--restore-missing-local-owner')) {
      const values = Object.fromEntries(existing.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#'))
        .map(line => [line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
      if (!/^owner-[a-f0-9]+@aj\.local$/.test(values.AJ_LOCAL_OWNER_EMAIL ?? '') || !values.AJ_LOCAL_OWNER_PASSWORD) {
        throw new Error('Refusing to restore an account that was not generated for AJ local development.');
      }
      const login = await createClient(status.API_URL,status.ANON_KEY,{auth}).auth.signInWithPassword({
        email:values.AJ_LOCAL_OWNER_EMAIL,password:values.AJ_LOCAL_OWNER_PASSWORD});
      if (login.error) {
        // createUser refuses duplicate identities. Never reset an existing password.
        const created = await admin.auth.admin.createUser({email:values.AJ_LOCAL_OWNER_EMAIL,
          password:values.AJ_LOCAL_OWNER_PASSWORD,email_confirm:true});
        if (created.error || !created.data.user) throw new Error('Could not create missing local owner; existing identity was not modified.');
        const role = await admin.from('user_roles').insert({user_id:created.data.user.id,role:'owner'});
        if (role.error) throw new Error('Could not provision local owner role.');
      }
      if (values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY !== status.ANON_KEY) {
        writeFileSync(file,existing.replace(/^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=.*$/m,
          `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${status.ANON_KEY}`),{mode:0o600});
      }
      console.log('Generated local owner is available. Existing passwords and business records were not reset.');
      return;
    }
    if (process.argv.includes('--rotate-owner-password')) {
      const values = Object.fromEntries(existing.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#'))
        .map(line => [line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
      if (!/^owner-[a-f0-9]+@aj\.local$/.test(values.AJ_LOCAL_OWNER_EMAIL ?? '')) throw new Error('Not a generated local owner.');
      const {data: login, error: loginError} = await createClient(status.API_URL,status.ANON_KEY,{auth}).auth
        .signInWithPassword({email:values.AJ_LOCAL_OWNER_EMAIL,password:values.AJ_LOCAL_OWNER_PASSWORD});
      if (loginError || !login.user) throw new Error('Could not authenticate local owner.');
      const nextPassword = randomBytes(24).toString('base64url');
      const {error: updateError} = await admin.auth.admin.updateUserById(login.user.id,{password:nextPassword});
      if (updateError) throw updateError;
      writeFileSync(file,existing.replace(/^AJ_LOCAL_OWNER_PASSWORD=.*$/m,`AJ_LOCAL_OWNER_PASSWORD=${nextPassword}`),{mode:0o600});
      console.log('Local owner password rotated in .env.local. Credentials were not printed.');
      return;
    }
    console.log('Existing AJ local configuration preserved.');
    return;
  }
  const email = `owner-${randomBytes(4).toString('hex')}@aj.local`;
  const password = randomBytes(24).toString('base64url');
  const {data, error} = await admin.auth.admin.createUser({email, password, email_confirm: true});
  if (error) throw error;
  const {error: roleError} = await admin.from('user_roles').insert({user_id: data.user.id, role: 'owner'});
  if (roleError) throw new Error('Could not assign owner role. Run local:migrate before local:setup.');
  writeFileSync(file, [
    'NEXT_PUBLIC_DATA_SOURCE=supabase',
    `NEXT_PUBLIC_SUPABASE_URL=${status.API_URL}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${status.ANON_KEY}`,
    '# Local development account only. These two values are never sent to the browser bundle.',
    `AJ_LOCAL_OWNER_EMAIL=${email}`,
    `AJ_LOCAL_OWNER_PASSWORD=${password}`,
    '',
  ].join('\n'), {flag: 'wx', mode: 0o600});
  console.log('Created .env.local with a local owner account. Read credentials there; restart npm run dev.');
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/setup-local.mjs')) {
  main().catch(() => {console.error('Local setup failed. Check Docker, local:start and local:migrate. Existing files were not overwritten.'); process.exitCode = 1;});
}
