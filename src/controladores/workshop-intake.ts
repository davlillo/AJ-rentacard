import type {Vehicle} from '../types';
import type {BusinessCommand, CommandResult} from '../lib/supabase/business';

type IntakeVehicle = Pick<Vehicle,'id'|'status'|'ownership'|'inRentalFleet'|'version'>;
type IntakeOrder = {vehicleId:string;status:string};
export interface IntakeDraft {
  internalJob:boolean;
  customerId:string;
  vehicleId:string;
  service:string;
  area:string;
  due:string;
  newVehicle:Record<'plate'|'brand'|'model'|'year'|'color'|'category',string>|null;
}
export interface IntakeProposal {name:BusinessCommand;payload:Record<string,unknown>;}

export function eligibleIntakeVehicles<T extends IntakeVehicle>(
  vehicles:readonly T[],orders:readonly IntakeOrder[],internalJob:boolean,
):T[]{
  const open=new Set(orders.filter(order=>order.status!=='Entregado').map(order=>order.vehicleId));
  return vehicles.filter(vehicle=>(internalJob
    ? vehicle.inRentalFleet&&vehicle.status==='Disponible'
    : !vehicle.inRentalFleet&&vehicle.ownership!=='Propio'&&['Disponible','Por confirmar'].includes(vehicle.status))
    &&!open.has(vehicle.id));
}

export function intakeProgress(customerReady:boolean,vehicleReady:boolean,created:boolean):number{
  return created?3:!customerReady?0:!vehicleReady?1:2;
}

export function intakeProposal(
  draft:IntakeDraft,vehicles:readonly IntakeVehicle[],orders:readonly IntakeOrder[],can:(permission:string)=>boolean,
):IntakeProposal{
  if(!can('orders.write')||(!draft.internalJob&&draft.newVehicle&&!can('vehicles.write'))){
    throw new Error('No tiene permiso para registrar esta entrada.');
  }
  if(!draft.internalJob&&!draft.customerId)throw new Error('Seleccione un cliente activo.');
  const vehicle=eligibleIntakeVehicles(vehicles,orders,draft.internalJob).find(car=>car.id===draft.vehicleId);
  if((draft.internalJob||!draft.newVehicle)&&!vehicle)throw new Error('Seleccione un vehículo disponible para este tipo de entrada.');
  if(!draft.service.trim())throw new Error('Indique el motivo del ingreso.');
  return {
    name:draft.internalJob?'receive_vehicle':'receive_workshop_vehicle',
    payload:{
      customerId:draft.internalJob?null:draft.customerId,internalJob:draft.internalJob,
      vehicleId:!draft.internalJob&&draft.newVehicle?null:draft.vehicleId,
      service:draft.service.trim(),area:draft.area,due:draft.due||null,
      ...(!draft.internalJob&&draft.newVehicle?{newVehicle:draft.newVehicle}:{expectedVersion:vehicle?.version}),
    },
  };
}

/** An unresolved response can only replay the original request, never a newly edited proposal. */
export class IntakeAttempt {
  private request:{proposal:IntakeProposal;key:string}|null=null;
  private sending=false;
  get pending():boolean{return this.request!==null;}
  resetAfterVersionConflict():void{if(!this.sending)this.request=null;}
  async submit(
    proposal:IntakeProposal,
    command:(name:BusinessCommand,payload:Record<string,unknown>,key:string)=>Promise<CommandResult>,
  ):Promise<CommandResult|null>{
    if(this.sending)return null;
    this.request??={proposal:structuredClone(proposal),key:crypto.randomUUID()};
    this.sending=true;
    try{return await command(this.request.proposal.name,this.request.proposal.payload,this.request.key);}
    finally{this.sending=false;}
  }
}
