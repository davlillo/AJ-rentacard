import {createSupabaseBrowserClient} from './client';
import {readRows} from './business';
import type {Customer,Vehicle} from '@/types';

export interface Reservation {
  id:string;customer_id:string;vehicle_id:string;starts_at:string;ends_at:string;daily_rate:number;total:number;
  cleaning_minutes:number;status:'Borrador'|'Confirmada'|'Cancelada';rental_state:'Preparado'|'Entregado'|'Devuelto'|'Cerrado';
  seller_id:string;customer_snapshot:Customer;vehicle_snapshot:Vehicle;version:number;created_at:string;open_ended?:boolean;folio_number?:number;
}
export interface Commitment {id:string;vehicle_id:string;reservation_id:string|null;order_id:string|null;kind:'Reserva'|'Taller'|'Limpieza'|'Uso interno'|'Préstamo';starts_at:string;ends_at:string;active:boolean;reason:string;}
export interface ReservationEvidence {id:string;reservation_id:string;channel:string;body:string;occurred_at:string;created_by:string;created_at:string;}
export type ReservationCommand='create'|'confirm'|'cancel'|'extend'|'evidence'|'block'|'finish_block'|'plan_workshop'|'period'|'set_end';
export const reservationMessages:Record<string,string>={
  PERMISSION_DENIED:'No tiene permiso para esta acción.',RENTAL_CONFLICT:'El intervalo coincide con otro compromiso. Revise las alternativas.',
  VERSION_CONFLICT:'La reserva cambió. Actualice antes de guardar.',INVALID_RENTAL_PARTIES:'Seleccione cliente activo y vehículo incluido en flota.',
  INVALID_OPEN_RENTAL_END:'Indique una fecha final futura y un motivo para el alquiler abierto.',
  END_PREDATES_BILLED_PERIOD:'La fecha final no puede ser anterior a un período ya documentado.',
  INVALID_RENTAL_PERIOD:'Revise el período, las fechas del alquiler y el motivo; no se permiten períodos superpuestos.',
  INVALID_EXTENSION:'La extensión debe terminar después de la fecha actual y tener un motivo.',
  INVALID_CANCELLATION:'Solo se puede cancelar una reserva aún no entregada, con motivo.',
  RESERVATION_NOT_DRAFT:'La reserva ya no es un borrador.',INVALID_RATE_PRECISION:'La tarifa admite hasta dos decimales.',
  BLOCK_CANNOT_BE_FINISHED:'El bloqueo está inactivo, aún no comenzó o pertenece a una orden; revise la entrega de taller.',
  RETURN_CLEANING_REQUIRED:'La devolución solo puede liberarse al completar su propia limpieza activa.',
  RENTAL_NOT_READY_FOR_DEPARTURE:'La reserva debe estar confirmada y dentro de su intervalo; el vehículo debe estar listo y disponible.',
  ODOMETER_CANNOT_DECREASE:'El kilometraje no puede ser inferior al registrado anteriormente.',
  RENTAL_NOT_OUT:'La reserva no está en estado entregado.',
  EXTRA_AMOUNT_REQUIRED:'Indique un importe positivo para aprobar el extra.',
};
export async function rentalRpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const {data,error}=await createSupabaseBrowserClient().rpc(name,args);
  if(error)throw new Error(error.code==='23P01'?reservationMessages.RENTAL_CONFLICT:
    reservationMessages[error.message]??'No se guardó la operación. Revise los datos y la conexión.');
  return data as T;
}
export async function loadCalendar(){
  const [reservations,commitments,evidence,paymentStatuses]=await Promise.all([readRows<Reservation>('reservations','*'),
    readRows<Commitment>('vehicle_commitments','*'),readRows<ReservationEvidence>('reservation_evidence','*'),
    rentalRpc<Record<string,string>>('reservation_payment_summary',{})]);
  return{reservations,commitments,evidence,paymentStatuses};
}
export async function reservationCommand(command:ReservationCommand,payload:Record<string,unknown>,key:string):Promise<Reservation>{
  return rentalRpc('execute_reservation_command',{command,payload,idempotency_key:key});
}
export async function rentalAlternatives(startsAt:string,endsAt:string,reservationId?:string):Promise<{id:string;plate:string;category:string}[]>{
  return rentalRpc('rental_alternatives',{starts_at:startsAt,ends_at:endsAt,exclude_reservation:reservationId??null});
}
export const salvadorDateTime=(value:string)=>new Date(value+'-06:00').toISOString();
export interface RentalInspection {id:string;reservation_id:string;kind:'Salida'|'Retorno';km:number;fuel:number;condition:string;accessories:string;evidence:string;occurred_at:string;created_by:string;}
export interface RentalExtra {id:string;reservation_id:string;description:string;amount:number|null;status:string;version:number;reason:string;}
export async function loadRentalInspections(reservationId:string){
  const [inspections,extras]=await Promise.all([readRows<RentalInspection>('rental_inspections','*'),readRows<RentalExtra>('rental_extra_proposals','*')]);
  return{inspections:inspections.filter(i=>i.reservation_id===reservationId),extras:extras.filter(e=>e.reservation_id===reservationId)};
}
