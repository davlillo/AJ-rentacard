import type {Reservation,RentalInspection} from '../lib/supabase/reservations';
import {folio} from './folios';

export type InspectionIntent='idle'|'departure'|'return';
export interface InspectionDraft {
  intent:Exclude<InspectionIntent,'idle'>;command:'depart'|'return';reservationId:string;expectedVersion:number;
  folio:string;customer:string;vehicle:string;km:string;fuel:string;review:string;
}
export interface InspectionConfirmation {
  command:'depart'|'return';payload:Record<string,unknown>;folio:string;customer:string;vehicle:string;reviewedAt:string;
}

export function startInspection(booking:Reservation,intent:Exclude<InspectionIntent,'idle'>):InspectionDraft{
  if(booking.status!=='Confirmada'||booking.rental_state!==(intent==='departure'?'Preparado':'Entregado')){
    throw new Error('La fase del alquiler cambió. Revise el folio antes de iniciar la inspección.');
  }
  return{intent,command:intent==='departure'?'depart':'return',reservationId:booking.id,expectedVersion:booking.version,
    folio:folio('ALQ',booking.folio_number),customer:booking.customer_snapshot.name,
    vehicle:[booking.vehicle_snapshot.plate,booking.vehicle_snapshot.brand,booking.vehicle_snapshot.model].filter(Boolean).join(' · '),
    km:'',fuel:'',review:''};
}

export function inspectionBaseline(booking:Reservation,inspections:RentalInspection[]):number|null{
  const departure=inspections.find(inspection=>inspection.kind==='Salida')?.km;
  const vehicle=booking.vehicle_snapshot.unverified_fields?.includes('km')?null:booking.vehicle_snapshot.km;
  const known=[departure,vehicle].filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
  return known.length?Math.max(...known):null;
}

export function confirmInspection(draft:InspectionDraft,baseline:number|null,reviewedAt=new Date().toISOString()):InspectionConfirmation{
  const km=Number(draft.km);const fuel=Number(draft.fuel);const review=draft.review.trim();
  if(!draft.km.trim()||!Number.isSafeInteger(km)||km<0||km>2147483647){
    throw new Error('Indique un kilometraje entero mayor o igual a cero.');
  }
  if(baseline!==null&&km<baseline)throw new Error('El kilometraje no puede ser inferior al último registro conocido.');
  if(!draft.fuel.trim()||!Number.isFinite(fuel)||fuel<0||fuel>100||Math.abs(fuel*100-Math.round(fuel*100))>0.000001){
    throw new Error('Indique combustible entre 0 y 100 %, con hasta dos decimales.');
  }
  if(!review||review.length>4000)throw new Error('Complete la revisión general (máximo 4000 caracteres).');
  // The command and expected version belong to this intent, never to refreshed props.
  return Object.freeze({command:draft.command,payload:Object.freeze({
    reservationId:draft.reservationId,expectedVersion:draft.expectedVersion,km,fuel,
    condition:review,accessories:'',evidence:review,
  }),folio:draft.folio,customer:draft.customer,vehicle:draft.vehicle,reviewedAt});
}

export function readingLabel(value:number|null|undefined,unit:'km'|'%'):string{
  return value==null?'Sin registro':`${value.toLocaleString('es-SV')} ${unit}`;
}
