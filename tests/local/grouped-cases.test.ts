import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {localStatus} from '../../scripts/setup-local.mjs';

test('Grouped CCF over real HTTP: scoped allocations, atomic collection, refund, credit, commission and open contract PDF',async()=>{
  const status=localStatus();const auth={persistSession:false,autoRefreshToken:false};const run=crypto.randomUUID();
  const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth});const email=`grouped-${run}@aj.local`;
  const password=crypto.randomUUID()+crypto.randomUUID();const user=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(user.error);
  assert.ifError((await admin.from('user_roles').insert({user_id:user.data.user!.id,role:'owner'})).error);
  const client=createClient(status.API_URL,status.ANON_KEY,{auth});assert.ifError((await client.auth.signInWithPassword({email,password})).error);
  async function rpc<T=Record<string,unknown>>(name:string,args:Record<string,unknown>):Promise<T>{const r=await client.rpc(name,args);assert.ifError(r.error);return r.data as T;}
  const command=<T=Record<string,unknown>>(name:string,action:string,payload:Record<string,unknown>)=>rpc<T>(name,{command:action,payload,idempotency_key:crypto.randomUUID()});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
  try{
    const customer=await command<{id:string}>('execute_command','create_customer',{name:`Grouped HTTP ${run}`,phone:String(randomInt(10000000,99999999)),type:'Empresa'});
    const cars:{id:string}[]=[];const bookings:{id:string;version:number}[]=[];
    for(let i=0;i<2;i++){
      const car=await command<{id:string}>('execute_command','create_vehicle',{plate:`CCF-HTTP-${i}-${run}`,brand:'Test',model:'Grouped',year:2026,category:'SUV',color:'White',daily:'40',km:'0',ownership:'Propio'});
      cars.push(car);
      let b=await command<{id:string;version:number}>('execute_reservation_command','create',{vehicleId:car.id,customerId:customer.id,startsAt:today+'T00:00:00-06:00',openEnded:true,dailyRate:'40'});
      b=await command('execute_reservation_command','confirm',{reservationId:b.id,expectedVersion:b.version});bookings.push(b);
    }
    const doc=await rpc<{id:string;amount:number}>('issue_grouped_document',{payload:{customerId:customer.id,externalReference:`TEST CCF ${run}`,
      description:'Two-car CCF HTTP acceptance',date:today,dueOn:today,lines:[
        {reservationId:bookings[0].id,description:'Vehicle A HTTP',gross:'100',discount:'10',discountReason:'Approved GPS deduction',startsOn:today,endsOn:today},
        {reservationId:bookings[1].id,description:'Vehicle B HTTP',gross:'200',discount:'0',startsOn:today,endsOn:today}]},idempotency_key:crypto.randomUUID()});
    assert.equal(doc.amount,290);
    const lines=await rpc<{id:string;reservation_id:string}[]>('billing_line_positions',{document_id:doc.id});
    const a=lines.find(l=>l.reservation_id===bookings[0].id)!;const b=lines.find(l=>l.reservation_id===bookings[1].id)!;
    const collection={documentId:doc.id,amount:'150',date:today,method:'Efectivo',account:`Grouped HTTP ${run}`,reference:'One grouped receipt'};
    const invalid=await client.rpc('collect_document',{payload:collection,idempotency_key:crypto.randomUUID()});
    assert.equal(invalid.error?.message,'EXPLICIT_DOCUMENT_ALLOCATIONS_REQUIRED');
    assert.equal((await client.from('customer_payments').select('id').eq('customer_id',customer.id)).data?.length,0);
    const args={payload:{...collection,allocations:[{lineId:a.id,amount:'90'},{lineId:b.id,amount:'60'}]},idempotency_key:crypto.randomUUID()};
    const raced=await Promise.all([client.rpc('collect_document',args),client.rpc('collect_document',args)]);
    raced.forEach(r=>assert.ifError(r.error));assert.equal(raced[0].data.receipt.id,raced[1].data.receipt.id);
    await command('execute_billing_command','refund',{documentId:doc.id,paymentId:raced[0].data.receipt.id,amount:'20',date:today,reason:'Refund B only',refundAccount:`Grouped HTTP ${run}`,allocations:[{lineId:b.id,amount:'20'}]});
    await command('execute_billing_command','credit',{documentId:doc.id,amount:'20',date:today,reason:'Credit B only',allocations:[{lineId:b.id,amount:'20'}]});
    const ca=await rpc<{documents:{scope_balance:number}[]}>('rental_case_file',{reservation_id:bookings[0].id});
    const cb=await rpc<{documents:{scope_balance:number}[]}>('rental_case_file',{reservation_id:bookings[1].id});
    assert.equal(ca.documents[0].scope_balance,0);assert.equal(cb.documents[0].scope_balance,140);
    assert.equal(await rpc('rental_paid_through',{reservation_id:bookings[0].id}),today);
    await command('execute_commission_command','eligibility',{documentId:doc.id,eligible:true,reason:'Confirmed commercial rentals'});
    const rule=await command<{id:string}>('execute_commission_command','rule',{code:`HTTP-${run}`,rate:'0.10',validFrom:'2020-01-01',validUntil:'2040-01-01'});
    const commission=await command<{amount:number}>('execute_commission_command','calculate',{reservationId:bookings[1].id,ruleId:rule.id,cutoff:today});
    assert.equal(commission.amount,4);
    const contract=await command<{id:string}>('execute_contract_command','version',{reservationId:bookings[0].id,parentId:null,reason:'Open-ended terms',conditions:'No final return date agreed; daily tariff is fixed.'});
    const pdf=await rpc<{base64:string}>('contract_pdf',{contract_id:contract.id});
    const body=Buffer.from(pdf.base64,'base64').toString('ascii');
    assert.ok(body.includes(Buffer.from('Sin fecha final acordada','latin1').toString('hex')));
    assert.ok(body.includes(Buffer.from('Precio final no definido. Tarifa diaria USD: 40','latin1').toString('hex')));
    const diary=await rpc<{netMovement:number;rows:unknown[]}>('cash_diary',{from_date:today,to_date:today,account_filter:`Grouped HTTP ${run}`});
    assert.equal(diary.netMovement,130);assert.equal(diary.rows.length,2);
  }finally{await client.auth.signOut({scope:'local'});}
});
