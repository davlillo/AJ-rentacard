import assert from 'node:assert/strict';
import {test} from 'node:test';
import {eligibleIntakeVehicles, intakeProposal, intakeProgress, IntakeAttempt} from '../src/controladores/workshop-intake';
import type {Vehicle} from '../src/types';

const vehicle=(id:string, extra:Partial<Vehicle>={}):Vehicle=>({
  id,plate:id,brand:'Toyota',model:'Corolla',year:2026,category:'Sedán',color:'',
  daily:0,km:0,status:'Disponible',ownership:'Cliente',inRentalFleet:false,version:3,...extra,
});
const cars=[vehicle('client'),vehicle('legacy',{inRentalFleet:undefined,ownership:undefined}),
  vehicle('fleet-client',{inRentalFleet:true}),vehicle('own',{ownership:'Propio'}),
  vehicle('busy',{status:'En taller'}),vehicle('open')];
const orders=[{vehicleId:'open',status:'Presupuesto'}];

test('Customer intake excludes rental fleet regardless of ownership and preserves legacy customers',()=>{
  assert.deepEqual(eligibleIntakeVehicles(cars,orders,false).map(v=>v.id),['client','legacy']);
  assert.deepEqual(eligibleIntakeVehicles(cars,orders,true).map(v=>v.id),['fleet-client']);
});
test('Existing intake uses selected version and canonical command; internal has no customer sale',()=>{
  const draft={internalJob:false,customerId:'customer',vehicleId:'client',service:'Diagnosis',area:'Mecánica',due:'',newVehicle:null};
  assert.deepEqual(intakeProposal(draft,cars,orders,()=>true),{
    name:'receive_workshop_vehicle',payload:{customerId:'customer',internalJob:false,vehicleId:'client',
      service:'Diagnosis',area:'Mecánica',due:null,expectedVersion:3},
  });
  const result=intakeProposal({...draft,internalJob:true,customerId:'',vehicleId:'fleet-client'},cars,orders,()=>true);
  assert.equal(result.name,'receive_vehicle');
  assert.equal(result.payload.customerId,null);
  assert.equal('price' in result.payload,false);
});
test('New vehicle is atomic with OT and requires vehicles.write as well as orders.write',()=>{
  const draft={internalJob:false,customerId:'customer',vehicleId:'',service:'Diagnosis',area:'Pintura',due:'',
    newVehicle:{plate:'',brand:'Toyota',model:'Yaris',year:'2026',color:'',category:'Sedán'}};
  assert.throws(()=>intakeProposal(draft,cars,orders,p=>p!=='vehicles.write'),/permiso/);
  assert.throws(()=>intakeProposal(draft,cars,orders,()=>false),/permiso/);
  const result=intakeProposal(draft,cars,orders,()=>true);
  assert.equal(result.name,'receive_workshop_vehicle');
  assert.equal(result.payload.vehicleId,null);
  assert.deepEqual(result.payload.newVehicle,draft.newVehicle);
});
test('Missing customer, invalid fleet and open work cannot be submitted',()=>{
  const draft={internalJob:false,customerId:'customer',vehicleId:'client',service:'Diagnosis',area:'Mecánica',due:'',newVehicle:null};
  assert.throws(()=>intakeProposal({...draft,customerId:''},cars,orders,()=>true),/cliente/);
  for(const id of ['fleet-client','own','busy','open','missing']){
    assert.throws(()=>intakeProposal({...draft,vehicleId:id},cars,orders,()=>true),/vehículo/);
  }
});
test('Intake progress is identity evidence, not quotation approval or workshop stages',()=>{
  assert.equal(intakeProgress(false,false,false),0);
  assert.equal(intakeProgress(true,false,false),1);
  assert.equal(intakeProgress(true,true,false),2);
  assert.equal(intakeProgress(true,true,true),3);
});
test('Concurrent submission is locked and ambiguous retry preserves exact payload and key',async()=>{
  const attempt=new IntakeAttempt();
  const seen:{key:string;payload:Record<string,unknown>}[]=[];
  let release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const proposal={name:'receive_workshop_vehicle' as const,payload:{vehicleId:'client',expectedVersion:3}};
  const command=async (_name:unknown,payload:Record<string,unknown>,key:string)=>{
    seen.push({payload,key});await wait;throw new Error('Lost response');
  };
  const first=attempt.submit(proposal,command);
  assert.equal(await attempt.submit(proposal,command),null);
  release();
  await assert.rejects(first,/Lost response/);
  await assert.rejects(attempt.submit({...proposal,payload:{expectedVersion:99}},command),/Lost response/);
  assert.equal(seen.length,2);
  assert.equal(seen[0].key,seen[1].key);
  assert.deepEqual(seen[1].payload,proposal.payload);
});
test('A confirmed version conflict can start a reviewed proposal with a fresh retry identity',async()=>{
  const attempt=new IntakeAttempt();
  const seen:string[]=[];
  const proposal={name:'receive_workshop_vehicle' as const,payload:{expectedVersion:3}};
  await assert.rejects(attempt.submit(proposal,async(_name,_payload,key)=>{
    seen.push(key);throw new Error('VERSION_CONFLICT');
  }));
  attempt.resetAfterVersionConflict();
  const result=await attempt.submit({...proposal,payload:{expectedVersion:4}},async(name,payload,key)=>{
    assert.equal(payload.expectedVersion,4);seen.push(key);
    return {id:'OT-2',command:name,createdAt:'2026-11-14'};
  });
  assert.equal(result?.id,'OT-2');
  assert.notEqual(seen[0],seen[1]);
});
