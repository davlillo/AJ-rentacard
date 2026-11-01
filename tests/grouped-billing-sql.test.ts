import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationalDb} from './helpers/operational-db';

test('One CCF across two cars: net GPS deduction and explicitly allocated payment/refund/credit',async()=>{
  const {db,command,rpc}=await operationalDb();
  try{
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(new Date());
    const customer=await command<{id:string}>('execute_command','create_customer',{name:'CCF acceptance',phone:'78904703',type:'Empresa'});
    const cars:{id:string}[]=[];const bookings:{id:string;version:number}[]=[];
    for(let i=0;i<2;i++){
      const car=await command<{id:string}>('execute_command','create_vehicle',{plate:`CCF-${i}`,brand:'Test',model:'Grouped',year:2026,category:'SUV',color:'White',daily:'40',km:'0',ownership:'Propio'});
      cars.push(car);
      let booking=await command<{id:string;version:number}>('execute_reservation_command','create',{
        vehicleId:car.id,customerId:customer.id,startsAt:`${today}T00:00:00-06:00`,openEnded:true,dailyRate:'40'});
      booking=await command('execute_reservation_command','confirm',{reservationId:booking.id,expectedVersion:booking.version});bookings.push(booking);
    }
    const payload={customerId:customer.id,description:'CCF two vehicles',externalReference:'2026 CCF #069',date:today,dueOn:today,lines:[
      {reservationId:bookings[0].id,description:'Vehicle A',gross:'100',discount:'10',discountReason:'Agreed GPS deduction',startsOn:today,endsOn:today},
      {reservationId:bookings[1].id,description:'Vehicle B',gross:'200',discount:'0',startsOn:today,endsOn:today}]};
    const args={payload:JSON.stringify(payload),idempotency_key:crypto.randomUUID()};
    const document=await rpc<{id:string;amount:number}>('issue_grouped_document',args);
    assert.deepEqual(await rpc('issue_grouped_document',args),document);assert.equal(document.amount,290);
    const lines=(await db.query<{id:string;reservation_id:string;amount:number}>('select * from public.billing_document_lines where document_id=$1',[document.id])).rows;
    const a=lines.find(l=>l.reservation_id===bookings[0].id)!;const b=lines.find(l=>l.reservation_id===bookings[1].id)!;
    const receipt=await command<{id:string}>('execute_billing_command','pay',{customerId:customer.id,amount:'150',date:today,method:'Efectivo',account:'CCF cash',reference:'One receipt only'});
    const base={documentId:document.id,paymentId:receipt.id,amount:'150',date:today};
    await assert.rejects(command('execute_billing_command','apply',base),/EXPLICIT_DOCUMENT_ALLOCATIONS_REQUIRED/);
    await assert.rejects(command('execute_billing_command','apply',{...base,allocations:[{lineId:a.id,amount:'150'}]}),/DOCUMENT_LINE_BALANCE_EXCEEDED/);
    await command('execute_billing_command','apply',{...base,allocations:[{lineId:a.id,amount:'90'},{lineId:b.id,amount:'60'}]});
    const caseA=await rpc<{documents:{scope_amount:number;scope_balance:number}[]}>('vehicle_case_file',{vehicle_id:cars[0].id});
    const caseB=await rpc<{documents:{scope_amount:number;scope_balance:number}[]}>('vehicle_case_file',{vehicle_id:cars[1].id});
    assert.equal(caseA.documents[0].scope_amount,90);assert.equal(caseA.documents[0].scope_balance,0);
    assert.equal(caseB.documents[0].scope_amount,200);assert.equal(caseB.documents[0].scope_balance,140);
    assert.equal((await rpc<Date>('rental_paid_through',{reservation_id:bookings[0].id})).toISOString().slice(0,10),today);
    assert.equal(await rpc('rental_paid_through',{reservation_id:bookings[1].id}),null);
    await command('execute_billing_command','refund',{documentId:document.id,paymentId:receipt.id,amount:'10',date:today,reason:'Partial refund on A',allocations:[{lineId:a.id,amount:'10'}]});
    await command('execute_billing_command','credit',{documentId:document.id,amount:'20',date:today,reason:'Additional B credit',allocations:[{lineId:b.id,amount:'20'}]});
    const ledger=await rpc<{balance:number}[]>('receivables_at',{cutoff:today});
    assert.equal(ledger[0].balance,130);
    await command('execute_command','record_expense',{vehicleId:cars[0].id,date:today,amount:'5',concept:'Parking on A',category:'Airport',method:'Efectivo',account:'CCF cash'});
    const reportA=await rpc<{billedIncome:number;actualDirectCost:number}>('vehicle_contribution',{vehicle_id:cars[0].id,from_date:today,cutoff:today});
    const reportB=await rpc<{billedIncome:number}>('vehicle_contribution',{vehicle_id:cars[1].id,from_date:today,cutoff:today});
    assert.equal(reportA.billedIncome,90);assert.equal(reportA.actualDirectCost,5);assert.equal(reportB.billedIncome,180);
    await command('execute_commission_command','eligibility',{documentId:document.id,eligible:true,reason:'Both rental lines are commercial, not deposits'});
    const rule=await command<{id:string}>('execute_commission_command','rule',{code:'GROUPED',rate:'0.10',validFrom:'2020-01-01',validUntil:'2040-01-01'});
    const commissionA=await command<{amount:number}>('execute_commission_command','calculate',{reservationId:bookings[0].id,ruleId:rule.id,cutoff:today});
    const commissionB=await command<{amount:number}>('execute_commission_command','calculate',{reservationId:bookings[1].id,ruleId:rule.id,cutoff:today});
    assert.equal(commissionA.amount,8);assert.equal(commissionB.amount,6);
    assert.equal((await db.query('select id from public.customer_payments')).rows.length,1);
    assert.equal((await db.query('select id from public.billing_documents')).rows.length,1);
  }finally{await db.close();}
});
