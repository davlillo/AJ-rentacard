import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('Business command retries recheck permission after the same actor loses the former role',async()=>{
  const {db,command,owner,asUser}=await operationalDb();
  try{
    const key=crypto.randomUUID();const payload={name:'Permission replay acceptance',phone:'78904710',type:'Personal'};
    await command('execute_command','create_customer',payload,key);
    await db.exec('reset role');await db.query("update public.user_roles set role='technician' where user_id=$1",[owner]);await asUser(owner);
    await assert.rejects(command('execute_command','create_customer',payload,key),/PERMISSION_DENIED/);
  }finally{await db.close();}
});
