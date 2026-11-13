import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';

export const ROOT='test-results/local-workspace';
export const LABEL='aj-local-workspace-v1';
export const CASH='Caja principal';
export const fleetSpecs=[
  {brand:'Toyota',model:'Corolla',year:2022,color:'Plata',category:'Sedán',daily:40,km:42000},
  {brand:'Hyundai',model:'Accent',year:2021,color:'Blanco',category:'Sedán',daily:36,km:51000},
  {brand:'Kia',model:'Rio',year:2023,color:'Rojo',category:'Compacto',daily:32,km:28000},
  {brand:'Nissan',model:'Versa',year:2022,color:'Plata',category:'Sedán',daily:45,km:36000},
  {brand:'Suzuki',model:'Swift',year:2023,color:'Rojo',category:'Compacto',daily:38,km:24000},
  {brand:'Nissan',model:'Sentra',year:2020,color:'Gris',category:'Sedán',daily:0,km:78000},
  {brand:'Ford',model:'Escape',year:2021,color:'Blanco',category:'SUV',daily:0,km:64000},
];
const names=['Ana Martínez','Carlos Rivera','Lucía Hernández','Daniel Torres','Sofía Reyes','Miguel Castillo','Valeria Flores'];
const DAY=86400000;
export const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
export function saveJson(path,value){
  const temporary=path+'.pending';
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  renameSync(temporary,path);
}

export async function seedLocalScenario(client,users,replacementId){
  const path=`${ROOT}/journal.json`;
  const journal=existsSync(path)?readJson(path):{
    version:1,label:LABEL,replacementId,anchor:new Date().toISOString(),commands:{},complete:false,
  };
  if(journal.label!==LABEL||journal.replacementId!==replacementId||journal.version!==1)
    throw new Error('LOCAL_JOURNAL_MISMATCH');
  if(journal.complete)return journal.manifest;
  saveJson(path,journal);
  const today=new Date(journal.anchor).toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
  const day=(offset=0)=>new Date(Date.parse(today+'T12:00:00Z')+offset*DAY).toISOString().slice(0,10);
  const instant=(offset=0)=>day(offset)+'T09:00:00-06:00';
  async function call(label,name,payload,extra={}){
    let entry=journal.commands[label];
    if(entry&&entry.result!==undefined)return entry.result;
    if(!entry||entry.failed){
      entry={key:randomUUID(),name,payload,extra};journal.commands[label]=entry;saveJson(path,journal);
    }
    const {data,error}=await client.rpc(entry.name,{...entry.extra,payload:entry.payload,idempotency_key:entry.key});
    if(error){
      // Only a definite SQL rollback permits a new key. An ambiguous network failure replays the same request.
      entry.failed=/^[0-9A-Z]{5}$/.test(error.code??'');saveJson(path,journal);
      throw new Error(`LOCAL_STEP_FAILED ${label}: ${error.message}`);
    }
    entry.result=data;entry.failed=false;saveJson(path,journal);return data;
  }
  const command=(label,fn,command,payload)=>call(label,fn,payload,{command});
  async function rows(table,key,value){
    const result=await client.from(table).select('*').eq(key,value);
    if(result.error)throw new Error('LOCAL_READ_FAILED '+table);return result.data;
  }
  async function fresh(table,id){
    const result=(await rows(table,'id',id))[0];
    if(!result)throw new Error('LOCAL_RECORD_MISSING '+table);return result;
  }
  const customers=[];const cars=[];const closedJobs=[];const historicRentals=[];
  const photo=(label,index,vehicleId,orderId=null)=>call(label,'save_vehicle_file',{
    vehicleId,orderId,purpose:orderId?'Ingreso':'Vehículo',financial:false,
    name:`${fleetSpecs[index].model.toLowerCase()}-referencia.jpg`,mime:'image/jpeg',
    base64:readFileSync(`${ROOT}/images/vehicle-${index+1}.jpg`).toString('base64'),
  });
  async function task(label,orderId,description,assignedTo,finish=false){
    let item=await command(label,'execute_task_command','create',{orderId,description,assignedTo});
    item=await command(label+'.start','execute_task_command','transition',{
      taskId:item.id,expectedVersion:item.version,status:'En proceso',
    });
    if(finish)item=await command(label+'.finish','execute_task_command','transition',{
      taskId:item.id,expectedVersion:item.version,status:'Finalizada',
    });
    return item;
  }
  async function release(label,vehicleId){
    const block=await command(label,'execute_reservation_command','block',{
      vehicleId,kind:'Limpieza',startsAt:new Date().toISOString(),
      endsAt:new Date(Date.now()+60000).toISOString(),reason:'Revisión física y limpieza completadas.',
    });
    return command(label+'.finish','execute_reservation_command','finish_block',{
      blockId:block.id,reason:'Vehículo revisado y liberado; no quedan compromisos activos.',
    });
  }
  const approve=(label,quote,name)=>command(label,'execute_estimate_command','approve',{
    estimateId:quote.id,approverName:name,evidence:'Alcance, materiales y mano de obra revisados y autorizados.',
  });
  async function contract(label,booking,customer){
    const doc=await command(label,'execute_contract_command','version',{
      reservationId:booking.id,parentId:null,reason:'Condiciones del alquiler.',
      conditions:'Tarifa y fechas indicadas en la operación. Incluye inspección de salida y revisión al devolver. '+
        'La devolución anticipada no modifica por sí sola el precio pactado.',
    });
    await command(label+'.accept','execute_contract_command','accept',{
      contractId:doc.id,acceptedBy:customer.name,evidence:'Condiciones, tarifa y período aceptados en la recepción.',
    });
  }
  const collect=(label,customerId,amount,scope,documentId)=>call(label,'record_linked_receipt',{
    customerId,amount:String(amount),date:today,method:'Efectivo',account:CASH,
    reference:label,...scope,...(documentId?{documentId}:{}),
  });
  async function rental(label,index,start,end){
    let booking=await command(label,'execute_reservation_command','create',{
      customerId:customers[index].id,vehicleId:cars[index].id,startsAt:start,endsAt:end,
      dailyRate:fleetSpecs[index].daily,cleaningMinutes:0,
    });
    booking=await command(label+'.confirm','execute_reservation_command','confirm',{
      reservationId:booking.id,expectedVersion:booking.version,
    });
    await command(label+'.evidence','execute_reservation_command','evidence',{
      reservationId:booking.id,body:'Fechas, tarifa y condiciones del alquiler confirmadas con el cliente.',
    });
    await contract(label+'.contract',booking,customers[index]);return booking;
  }
  const inspection=km=>({km,fuel:80,condition:'Sin daños adicionales; carrocería y luces revisadas.',
    accessories:'Llave, repuesto, herramientas y documentos',evidence:'Inspección registrada en la recepción.'});
  await call('opening','record_cash_entry',{
    kind:'Apertura',date:day(-3),account:CASH,amount:'1000',concept:'Saldo inicial de caja',
    reason:'Apertura del período; no corresponde a un ingreso por ventas.',
  });
  for(let index=0;index<fleetSpecs.length;index++){
    const created=await command('customer.'+index,'execute_command','create_customer',{
      name:names[index],phone:'+5030000'+String(101+index),document:'',email:'',type:'Personal',
    });
    const customer={...created,name:names[index]};customers.push(customer);
    const car=await command('vehicle.'+index,'execute_command','create_vehicle',{
      ...fleetSpecs[index],plate:'P101-'+String(index+1).padStart(3,'0'),ownership:index<5?'Propio':'Cliente',
      ownerCustomerId:index<5?null:customer.id,inRentalFleet:index<5,initialStatus:'Disponible',unverifiedFields:[],
      registeredHolder:index<5?'AJ Rent a Car':customer.name,commercialLine:index<5?'Flota de alquiler':'Taller',
    });
    cars.push(car);await photo('photo.'+index,index,car.id);
  }
  const services=['Mantenimiento preventivo y cambio de aceite','Servicio de frenos y revisión de seguridad',
    'Revisión eléctrica y batería'];
  for(let index=0;index<3;index++){
    const job=await command('history.job.'+index,'execute_command','receive_vehicle',{
      vehicleId:cars[index].id,internalJob:true,area:'Mecánica',service:services[index],due:today,
    });
    closedJobs.push(job);
    await command('history.intake.'+index,'execute_case_command','intake',{
      orderId:job.id,...inspection(fleetSpecs[index].km),
    });
    await photo('history.photo.'+index,index,cars[index].id,job.id);
  }
  const split=await call('history.sharedExpense','record_linked_expense',{
    date:today,concept:'Un comprobante de materiales para tres mantenimientos',category:'Mantenimiento interno',
    amount:'180',method:'Efectivo',account:CASH,support:'MAT-001',
    allocations:closedJobs.map((job,index)=>({orderId:job.id,amount:String([75,65,40][index])})),
    reason:'Reparto: 75 + 65 + 40 = 180. Una sola salida de caja.',
  });
  for(let index=0;index<closedJobs.length;index++){
    const job=closedJobs[index];const cost=split.costs.find(cost=>cost.order_id===job.id);
    const quote=await call('history.quote.'+index,'record_connected_quote',{
      orderId:job.id,parentId:null,reason:'Alcance del mantenimiento interno',
      lines:[{description:services[index],kind:'Material',quantity:1,unitPrice:0,unitCost:cost.amount,
        sourceCostId:cost.id,sourceCostVersion:cost.version}],
    });
    await approve('history.approve.'+index,quote,'Coordinación de flota');
    const current=await fresh('workshop_costs',cost.id);
    await command('history.classify.'+index,'execute_cost_command','classify',{
      costId:cost.id,expectedVersion:current.version,disposition:'Interno',reason:'Mantenimiento asumido por AJ.',
    });
    await task('history.task.'+index,job.id,services[index]+' · completado',users.mechanic,true);
    const checklist=await client.rpc('workshop_delivery_checklist',{order_id:job.id});
    if(checklist.error)throw new Error('LOCAL_CHECKLIST_FAILED');
    await call('history.deliver.'+index,'deliver_workshop_order',{
      orderId:job.id,expectedVersion:checklist.data.version,recipient:'Coordinación de flota',
      evidence:'Tareas, presupuesto y materiales revisados.',exception:false,reason:'',creditReason:'',
      acknowledgePendingReception:false,
    });
    await release('history.release.'+index,cars[index].id);
  }
  for(let index=0;index<5;index++){
    // Occupancy starts after workshop delivery. Early return retains the agreed three-day price.
    const booking=await rental('rental.completed.'+index,index,new Date().toISOString(),
      new Date(Date.now()+3*DAY).toISOString());
    const scope={reservationId:booking.id};
    const period=await command('rental.history.period.'+index,'execute_reservation_command','period',{
      ...scope,startsOn:today,endsOn:day(2),amount:String(fleetSpecs[index].daily*3),date:today,dueOn:today,
      reason:'Período pactado de tres días; devolución anticipada sin ajuste de precio.',
    });
    await collect('rental.history.receipt.'+index,customers[index].id,fleetSpecs[index].daily*3,scope,period.document_id);
    await command('rental.history.depart.'+index,'execute_rental_command','depart',{
      ...scope,expectedVersion:booking.version,...inspection(fleetSpecs[index].km),
    });
    const outgoing=await fresh('reservations',booking.id);
    await command('rental.history.return.'+index,'execute_rental_command','return',{
      ...scope,expectedVersion:outgoing.version,...inspection(fleetSpecs[index].km+180),
    });
    const cleaning=(await rows('vehicle_commitments','reservation_id',booking.id))
      .find(block=>block.kind==='Limpieza'&&block.active);
    if(!cleaning)throw new Error('LOCAL_CLEANING_MISSING');
    await command('rental.history.clean.'+index,'execute_reservation_command','finish_block',{
      blockId:cleaning.id,reason:'Limpieza de la devolución verificada.',
    });
    await call('rental.history.expense.'+index,'record_linked_expense',{
      date:today,concept:'Limpieza del alquiler '+(index+1),category:'Limpieza',amount:'12',method:'Efectivo',
      account:CASH,...scope,support:'LIMPIEZA-'+(index+1),
    });
    historicRentals.push(booking);
  }
  const current=await rental('rental.current',3,new Date().toISOString(),
    new Date(Date.parse(journal.anchor)+4*DAY).toISOString());
  await command('rental.current.depart','execute_rental_command','depart',{
    reservationId:current.id,expectedVersion:current.version,...inspection(fleetSpecs[3].km+180),
  });
  const currentPeriod=await command('rental.current.period','execute_reservation_command','period',{
    reservationId:current.id,startsOn:today,endsOn:day(3),amount:'180',date:today,dueOn:day(2),
    reason:'Cuatro días a $45; un solo cargo.',
  });
  await collect('rental.current.receipt',customers[3].id,80,{reservationId:current.id},currentPeriod.document_id);
  await call('rental.current.expense','record_linked_expense',{
    date:today,concept:'Preparación y consumibles del Versa',category:'Operación de alquiler',amount:'25',
    method:'Efectivo',account:CASH,reservationId:current.id,support:'RENTA-006',
  });
  const reserved=await rental('rental.future',4,instant(2),instant(6));
  await collect('rental.future.advance',customers[4].id,60,{reservationId:reserved.id});
  const activeJobs=[];const quotes=[];
  for(let index=5;index<7;index++){
    const mechanic=index===5;const label=mechanic?'workshop.mechanic':'workshop.paint';
    const job=await command(label,'execute_command','receive_vehicle',{
      vehicleId:cars[index].id,customerId:customers[index].id,area:mechanic?'Mecánica':'Pintura',
      service:mechanic?'Frenos y suspensión delantera':'Reparación y pintura de puerta',due:day(mechanic?2:4),
    });
    activeJobs.push(job);
    await command(label+'.intake','execute_case_command','intake',{
      orderId:job.id,...inspection(fleetSpecs[index].km),
    });
    await photo(label+'.photo',index,cars[index].id,job.id);
    const expense=await call(label+'.expense','record_linked_expense',{
      date:today,concept:mechanic?'Kit de frenos y materiales':'Pintura y materiales de preparación',
      category:'Materiales',amount:mechanic?'180':'90',method:'Efectivo',account:CASH,
      support:mechanic?'TALLER-001':'TALLER-002',allocations:[{orderId:job.id,amount:mechanic?'180':'90'}],
      reason:'Gasto asociado al folio.',
    });
    const cost=expense.costs[0];
    let quote=await call(label+'.quote1','record_connected_quote',{
      orderId:job.id,parentId:null,reason:'Primera versión del alcance completo',lines:mechanic?[
        {description:'Kit de frenos y repuestos',kind:'Material',quantity:1,unitPrice:200,unitCost:180},
        {description:'Mano de obra mecánica',kind:'Trabajo',quantity:2,unitPrice:100,unitCost:null},
        {description:'Alineación y verificación',kind:'Tercero',quantity:1,unitPrice:120,unitCost:null},
      ]:[{description:'Reparación de puerta y pintura',kind:'Trabajo',quantity:1,unitPrice:700,unitCost:null}],
    });
    quote=await call(label+'.quote2','record_connected_quote',{
      orderId:job.id,parentId:quote.id,reason:mechanic?'Revisión de repuestos y mano de obra.':
        'Adicional por reparación de abolladura; pendiente de aprobación.',lines:mechanic?[
        {description:'Kit de frenos y repuestos',kind:'Material',quantity:1,unitPrice:240,unitCost:180,
          sourceCostId:cost.id,sourceCostVersion:cost.version},
        {description:'Mano de obra mecánica',kind:'Trabajo',quantity:2,unitPrice:120,unitCost:null},
        {description:'Alineación y verificación',kind:'Tercero',quantity:1,unitPrice:120,unitCost:null},
      ]:[{description:'Pintura y materiales',kind:'Material',quantity:1,unitPrice:400,unitCost:90,
        sourceCostId:cost.id,sourceCostVersion:cost.version},
      {description:'Preparación, reparación y acabado',kind:'Trabajo',quantity:3,unitPrice:150,unitCost:null}],
    });
    quotes.push(quote);
    if(mechanic){
      await approve(label+'.approve',quote,customers[index].name);const updated=await fresh('workshop_costs',cost.id);
      await command(label+'.classify','execute_cost_command','classify',{
        costId:cost.id,expectedVersion:updated.version,disposition:'Incluido',estimateId:quote.id,
        reason:'Material incluido en el presupuesto aprobado de $600.',
      });
      const charge=await command(label+'.charge','execute_case_command','bill_scope',{
        orderId:job.id,date:day(-2),dueOn:day(-1),
      });
      await collect(label+'.receipt',customers[index].id,200,{orderId:job.id},charge.id);
    }else await collect(label+'.advance',customers[index].id,100,{orderId:job.id});
    await task(label+'.diagnosis',job.id,mechanic?'Diagnóstico de frenos y suspensión':
      'Inspección y preparación de superficie',mechanic?users.mechanic:users.painter,true);
    await task(label+'.task',job.id,mechanic?'Instalar kit de frenos y comprobar suspensión':
      'Reparar abolladura y preparar pintura',mechanic?users.mechanic:users.painter);
  }
  const manifest={version:1,workspace:LABEL,replacementId,anchor:journal.anchor,today,account:CASH,
    vehicles:cars.map((car,index)=>({...fleetSpecs[index],id:car.id,plate:'P101-'+String(index+1).padStart(3,'0')})),
    customers:customers.map(c=>c.id),closedJobs:closedJobs.map(j=>j.id),historicRentals:historicRentals.map(r=>r.id),
    currentRental:current.id,reservedRental:reserved.id,activeJobs:activeJobs.map(j=>j.id),quotes:quotes.map(q=>q.id),
    expected:{fleet:5,available:3,rented:1,reserved:1,workshop:2,charges:1353,receipts:1013,expenses:535,
      balance:500,advances:160,cashNet:478,opening:1000}};
  journal.complete=true;journal.manifest=manifest;saveJson(path,journal);saveJson(`${ROOT}/manifest.json`,manifest);
  return manifest;
}
