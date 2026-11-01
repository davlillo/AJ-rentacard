import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('HU20/HU21 authorized partial receipts and idempotent net order consumption',async t=>{
  const {db,command}=await operationalDb();
  try{
    interface Row{id:string;version:number;}
    const item=await command<Row>('execute_inventory_command','item',{sku:'STOCK-1',name:'Brake pad',unit:'unit'});
    let purchase:Row;
    await t.test('receiving 3 of 5 increases stock by 3, leaves 2 pending and records liability once',async()=>{
      purchase=await command('execute_inventory_command','request',{itemId:item.id,supplier:'Synthetic supplier',quantity:'5',unitCost:'10',reason:'Replenishment'});
      await assert.rejects(command('execute_inventory_command','receive',{purchaseId:purchase.id,expectedVersion:purchase.version,quantity:'3',reason:'Delivery'}),/PURCHASE_NOT_AUTHORIZED/);
      purchase=await command('execute_inventory_command','authorize',{purchaseId:purchase.id,expectedVersion:purchase.version,reason:'Owner approved'});
      const key=crypto.randomUUID();const payload={purchaseId:purchase.id,expectedVersion:purchase.version,quantity:'3',reason:'Partial delivery'};
      const receipt=await command('execute_inventory_command','receive',payload,key);
      assert.deepEqual(await command('execute_inventory_command','receive',payload,key),receipt);
      assert.equal(Number((await db.query<{quantity:string}>('select quantity::text from public.stock_items where id=$1',[item.id])).rows[0].quantity),3);
      assert.equal(Number((await db.query<{pending:string}>(`select p.quantity-coalesce(sum(m.quantity),0) pending from public.purchase_orders p
        left join public.stock_movements m on m.purchase_id=p.id where p.id=$1 group by p.id`,[purchase.id])).rows[0].pending),2);
      assert.equal((await db.query('select id from public.supplier_obligations')).rows.length,1);
      assert.equal((await db.query('select id from public.workshop_costs')).rows.length,0);
      assert.equal((await db.query('select id from public.expenses')).rows.length,0);
    });
    await t.test('dispatch creates exactly one actual cost; return restores stock and reverses net order cost',async()=>{
      const customer=await command<Row>('execute_command','create_customer',{name:'Stock test',phone:'78901933',type:'Personal'});
      const car=await command<Row>('execute_command','create_vehicle',{plate:'STOCK-CAR',brand:'Test',model:'Car',year:2026,category:'Sedán',color:'White',daily:0,km:0,ownership:'Propio'});
      const order=await command<Row>('execute_command','receive_vehicle',{customerId:customer.id,vehicleId:car.id,area:'Mecánica',service:'Replace pads'});
      const payload={itemId:item.id,orderId:order.id,quantity:'2',reason:'Job consumption'};const key=crypto.randomUUID();
      const dispatch=await command<Row>('execute_inventory_command','consume',payload,key);
      assert.deepEqual(await command('execute_inventory_command','consume',payload,key),dispatch);
      assert.equal((await db.query('select id from public.workshop_costs where order_id=$1',[order.id])).rows.length,1);
      await assert.rejects(command('execute_inventory_command','consume',payload),/INSUFFICIENT_STOCK/);
      const returnKey=crypto.randomUUID();const returned={dispatchId:dispatch.id,quantity:'1',reason:'Unused piece returned'};
      await command('execute_inventory_command','return',returned,returnKey);await command('execute_inventory_command','return',returned,returnKey);
      assert.equal(Number((await db.query<{amount:string}>('select amount from public.workshop_costs where stock_dispatch_id=$1',[dispatch.id])).rows[0].amount),10);
      await command('execute_inventory_command','return',returned);
      assert.equal(Number((await db.query<{amount:string}>('select amount from public.workshop_costs where stock_dispatch_id=$1',[dispatch.id])).rows[0].amount),0);
      assert.equal(Number((await db.query<{quantity:string}>('select quantity from public.stock_items where id=$1',[item.id])).rows[0].quantity),3);
      await assert.rejects(command('execute_inventory_command','return',returned),/RETURN_EXCEEDS_DISPATCH/);
    });
  }finally{await db.close();}
});
