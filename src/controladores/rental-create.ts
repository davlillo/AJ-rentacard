import {salvadorDateTime} from '../lib/supabase/reservations';

export interface RentalCreationInput {
  customerId:string;vehicleId:string;startsAt:string;endsAt:string;openEnded:boolean;
  dailyRate:string;cleaningMinutes:string;
}
export function creationPayload(input:RentalCreationInput):Record<string,unknown>{
  if(!input.customerId||!input.vehicleId)throw new Error('Seleccione un cliente y un vehículo de la flota.');
  const localDate=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  if(!localDate.test(input.startsAt)||(!input.openEnded&&!localDate.test(input.endsAt))){
    throw new Error('Complete las fechas en horario de El Salvador.');
  }
  const startsAt=salvadorDateTime(input.startsAt);
  const endsAt=input.openEnded?null:salvadorDateTime(input.endsAt);
  if(endsAt&&endsAt<=startsAt)throw new Error('La devolución debe ser posterior a la entrega.');
  if(!/^\d+(\.\d{1,2})?$/.test(input.dailyRate)||!Number.isFinite(Number(input.dailyRate))){
    throw new Error('La tarifa debe ser positiva o cero y admitir hasta dos decimales.');
  }
  const cleaningMinutes=Number(input.cleaningMinutes);
  if(!input.cleaningMinutes.trim()||!Number.isInteger(cleaningMinutes)||cleaningMinutes<0||cleaningMinutes>10080){
    throw new Error('Indique minutos de limpieza entre 0 y 10080, sin decimales.');
  }
  return {customerId:input.customerId,vehicleId:input.vehicleId,startsAt,endsAt,
    openEnded:input.openEnded,dailyRate:input.dailyRate,cleaningMinutes};
}
type SavedDraft={id:string;version:number;status:string;rental_state:string;folio_number?:number};
type CreationCommand=(command:'create'|'confirm',payload:Record<string,unknown>,key:string)=>Promise<SavedDraft>;
export interface CreationJournal {key:string;id?:string;}
export interface RentalCreationAttempt {
  payload:Record<string,unknown>;createKey:string;confirmKey:string;saved?:SavedDraft;
}
export function createRentalAttempt(payload:Record<string,unknown>,key:()=>string):RentalCreationAttempt{
  return {payload:{...payload},createKey:key(),confirmKey:key()};
}
export async function saveRentalDraft(attempt:RentalCreationAttempt,command:CreationCommand,
  persist:(journal:CreationJournal)=>void):Promise<SavedDraft>{
  if(attempt.saved)return attempt.saved;
  // Persist a recovery lock before any request. A refresh must never start a second create.
  persist({key:attempt.createKey});
  const saved=await command('create',attempt.payload,attempt.createKey);
  attempt.saved=saved;
  persist({key:attempt.createKey,id:saved.id});
  return saved;
}
export async function confirmRentalDraft(attempt:RentalCreationAttempt,command:CreationCommand):Promise<SavedDraft>{
  if(!attempt.saved)throw new Error('Primero guarde el borrador.');
  if(attempt.saved.status!=='Borrador')return attempt.saved;
  return command('confirm',{reservationId:attempt.saved.id,expectedVersion:attempt.saved.version},attempt.confirmKey);
}
