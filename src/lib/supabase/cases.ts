import {createSupabaseBrowserClient} from './client';
import type {Vehicle,WorkOrder} from '@/types';
import type {WorkshopCost} from './workshop';
import type {QuoteVersion} from './estimates';
import type {Reservation,Commitment} from './reservations';
import type {CustomerPayment,PaymentApplication} from './billing';

export interface CaseOrder extends Omit<WorkOrder,'vehicleId'|'customerId'> {
  vehicle_id:string;customer_id:string|null;internal_job:boolean;pending_fields:string[];
  occurred_at:string;created_at:string;created_by:string;active_estimate_id:string|null;
}
export interface CaseVehicle extends Vehicle {in_rental_fleet:boolean;registered_holder:string;commercial_line:string;}
export interface VehicleFile {
  id:string;vehicle_id:string;order_id:string|null;reservation_id:string|null;name:string;
  mime:string;purpose:'Vehículo'|'Ingreso'|'Salida'|'Soporte';financial:boolean;size:number;created_at:string;
}
export interface CostAllocation {id:string;cost_id:string;estimate_id:string|null;line_index:number|null;description:string;amount:number;}
export interface CaseDocument {id:string;description:string;amount:number;scope_amount:number;scope_balance:number;issued_on:string;due_on:string;grouped?:boolean;folio_number?:number;}
export interface CaseExpense {id:string;date:string;concept:string;amount:number;account:string;support:string;direct_purchase_cost_id:string|null;}
export interface CaseFile {
  vehicle:CaseVehicle;financialAccess:boolean;orders:CaseOrder[];reservations:Reservation[];commitments:Commitment[];
  inspections:{id:string;order_id:string;km:number;fuel:number;condition:string;accessories:string;created_at:string}[];
  files:VehicleFile[];quotes?:QuoteVersion[];costs?:WorkshopCost[];allocations?:CostAllocation[];
  expenses?:CaseExpense[];documents?:CaseDocument[];applications?:(PaymentApplication&{scope_amount:number})[];payments?:CustomerPayment[];
}
const messages:Record<string,string>={
  PERMISSION_DENIED:'No tiene permiso para esta acción.',VERSION_CONFLICT:'El registro cambió. Actualice antes de guardar.',
  PARENT_VERSION_CONFLICT:'Existe una versión más reciente. Actualice el pliego.',
  VEHICLE_NOT_FOUND:'No existe el vehículo solicitado.',ORDER_NOT_FOUND:'El ingreso no pertenece a este vehículo.',
  ORDER_NOT_OPEN:'El ingreso ya está entregado.',ODOMETER_CANNOT_DECREASE:'El kilometraje no puede disminuir.',
  SCOPE_ALREADY_BILLED_OR_CREDIT_REQUIRED:'El alcance ya está facturado o requiere una nota de crédito, no otro cargo.',
  APPROVED_SCOPE_REQUIRED:'Apruebe primero el presupuesto vigente con evidencia.',
  ALLOCATION_TOTAL_MISMATCH:'El desglose debe sumar exactamente el costo original.',
  ESTIMATE_LINE_MISMATCH:'La partida debe pertenecer a un presupuesto de este ingreso.',
  ACTIVE_FLEET_COMMITMENTS:'No se puede retirar de la flota mientras tenga reservas activas.',
  INVALID_VEHICLE_FILE:'Use una imagen PNG, JPEG o WebP, o un PDF de soporte válido, de hasta 2 MB.',
  DOCUMENT_TOO_LARGE:'El archivo supera 2 MB.',FILE_DESTINATION_MISMATCH:'El archivo no pertenece a este vehículo e ingreso.',
  INVALID_ESTIMATE_LINE:'Revise descripción, cantidad, precio y costo opcional de las partidas.',
  CLEAR_ALLOCATIONS_BEFORE_COST_RETURN:'Retire el desglose antes de ajustar el costo por una devolución.',
  SOURCE_SIMILAR_RECORDS_REQUIRE_REVIEW:'Hay registros de igual fecha e importe. Vincule el existente o confirme con evidencia que es otro hecho real.',
  SOURCE_RECONCILIATION_MISMATCH:'El importe a publicar no coincide con el conciliado del original.',
  SOURCE_NOT_PUBLISHABLE:'El origen es un control, está excluido o aún no tiene una propuesta válida.',
  SOURCE_ALREADY_RESOLVED:'Este origen ya está vinculado o publicado; no se puede convertir en otro movimiento.',
};
export async function caseRpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const {data,error}=await createSupabaseBrowserClient().rpc(name,args);
  if(error)throw new Error(messages[error.message]??'No se completó la operación. Revise los datos y actualice antes de reintentar.');
  return data as T;
}
export function loadCase(vehicleId:string,orderId?:string):Promise<CaseFile>{
  return caseRpc('vehicle_case_file',{vehicle_id:vehicleId,order_id:orderId??null});
}
export async function findOrderVehicle(orderId:string):Promise<string>{
  const {data,error}=await createSupabaseBrowserClient().from('work_orders').select('vehicle_id').eq('id',orderId).maybeSingle();
  if(error||!data)throw new Error('El ingreso no existe o no está autorizado para esta sesión.');
  return data.vehicle_id;
}
export function caseCommand<T=unknown>(command:string,payload:Record<string,unknown>,key:string):Promise<T>{
  return caseRpc('execute_case_command',{command,payload,idempotency_key:key});
}
export async function readVehicleFile(id:string):Promise<{mime:string;name:string;base64:string}>{
  return caseRpc('vehicle_file_content',{file_id:id});
}
export async function uploadVehicleFile(file:File,payload:Record<string,unknown>,key:string):Promise<VehicleFile>{
  if(file.size>2097152)throw new Error(messages.DOCUMENT_TOO_LARGE);
  const {bytesToBase64}=await import('@/lib/documents/pdf');
  return caseRpc('save_vehicle_file',{payload:{...payload,name:file.name,mime:file.type,
    base64:bytesToBase64(new Uint8Array(await file.arrayBuffer()))},idempotency_key:key});
}
export const vehicleHref=(id:string)=>`/vehiculos/expediente/?id=${encodeURIComponent(id)}`;
export const orderHref=(id:string)=>`/taller/ingreso/?id=${encodeURIComponent(id)}`;
export const rentalHref=(id:string)=>`/vehiculos/alquiler/?id=${encodeURIComponent(id)}`;
export function loadRentalCase(id:string):Promise<CaseFile>{return caseRpc('rental_case_file',{reservation_id:id});}
