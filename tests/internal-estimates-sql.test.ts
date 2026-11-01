import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('Internal cost-only budget has no invented commercial price, margin or customer sale',async()=>{
  const {db,command}=await operationalDb();
  try{
    const car=await command<{id:string}>('execute_command','create_vehicle',{plate:'INTERNAL-BUDGET',brand:'Test',model:'Fleet',year:2026,category:'SUV',color:'White',daily:'40',km:'0',ownership:'Propio'});
    const order=await command<{id:string}>('execute_command','receive_vehicle',{vehicleId:car.id,internalJob:true,area:'Mecánica',service:'Internal maintenance plan'});
    const quote=await command<{id:string;snapshot:{cost:number;total:number;margin:null;marginPct:null}}>('execute_case_command','quote',{
      orderId:order.id,parentId:null,reason:'Cost-only internal plan',lines:[{description:'Oil and filter',kind:'Material',quantity:'1',unitCost:'75',unitPrice:'0'}]});
    assert.equal(quote.snapshot.cost,75);assert.equal(quote.snapshot.total,0);assert.equal(quote.snapshot.margin,null);assert.equal(quote.snapshot.marginPct,null);
    await command('execute_estimate_command','approve',{estimateId:quote.id,approverName:'Fleet manager',evidence:'Internal maintenance approval'});
    await assert.rejects(command('execute_case_command','bill_scope',{orderId:order.id,date:'2026-10-30',dueOn:'2026-10-30'}),/INTERNAL_VEHICLE_NOT_A_SALE/);
    assert.equal((await db.query('select id from public.customers')).rows.length,0);
  }finally{await db.close();}
});
