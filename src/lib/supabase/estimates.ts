import {createSupabaseBrowserClient} from './client';
import {readRows} from './business';
import type {Customer,Vehicle} from '@/types';

export interface WorkshopTariff {id:string;code:string;revision:number;description:string;kind:string;unit_cost:number;unit_price:number;}
export interface QuoteInput {tariffId:string;quantity:string;}
export interface QuoteCalculation {
  policy:string;currency:string;rounding:string;method:'commercial'|'margin'|'markup';ratio:number|null;
  lines:{tariffId:string|null;code:string;tariffRevision:number;description:string;kind:string;quantity:number;unitCost:number|null;unitPrice:number;cost:number|null;price:number}[];
  cost:number;costComplete?:boolean;commercial:number;subtotal:number;discount:number;total:number;margin:number|null;marginPct:number|null;
}
export interface QuoteVersion {
  id:string;order_id:string;revision:number;parent_id:string|null;status:'Borrador'|'Aprobado'|'Rechazado';
  snapshot:QuoteCalculation;customer_snapshot:Customer;vehicle_snapshot:Vehicle;reason:string;created_at:string;
  folio_number?:number;source_reference?:string;
  source_totals?:{initial:number;additional:number;advanceNotPosted:number;balanceNotPosted:number}|null;
}
export interface QuoteApproval {
  id:string;estimate_id:string;decision:string;approver_name:string;evidence:string;
  occurred_at:string;recorded_by:string;created_at:string;
}
const messages:Record<string,string>={
  PERMISSION_DENIED:'No tiene permiso para esta acción.',
  INVALID_PRICING_RATIO:'Seleccione un único método y una proporción válida. El margen debe ser menor de 100%.',
  INVALID_ESTIMATE_LINE:'Revise tarifa, cantidad positiva y precisión de las líneas.',
  INVALID_ESTIMATE_LINES:'Agregue entre 1 y 200 líneas.',INVALID_ESTIMATE_TOTAL:'El precio final debe ser positivo; revise el descuento.',
  INVALID_DISCOUNT:'El descuento debe ser un importe positivo o cero, con hasta dos decimales.',
  DISCOUNT_REQUIRES_MANAGEMENT:'La aprobación de descuentos requiere gerencia.',
  PARENT_VERSION_CONFLICT:'Existe una versión más reciente. Actualice el presupuesto antes de crear otra.',
  ESTIMATE_NOT_PENDING:'La versión ya tiene una decisión registrada.',SUPERSEDED_ESTIMATE:'Existe una versión posterior; revise el alcance vigente.',
  ORDER_NOT_OPEN:'La orden no está abierta.',VERSION_REASON_REQUIRED:'Indique el motivo de la versión.',
  VEHICLE_NOT_FOUND:'Seleccione un vehículo registrado.',INVALID_CUSTOMER:'Seleccione un cliente activo.',
  VEHICLE_HAS_OTHER_CUSTOMER_WORK:'Este vehículo ya tiene un trabajo abierto para otro cliente. Revise su expediente.',
  INTERNAL_FLEET_VEHICLE_REQUIRED:'El mantenimiento interno requiere un vehículo de la flota.',
};
async function rpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const {data,error}=await createSupabaseBrowserClient().rpc(name,args);
  if(error)throw new Error(messages[error.message]??'No se pudo guardar. Revise los campos, la evidencia y la conexión.');
  return data as T;
}
export async function loadEstimates():Promise<{tariffs:WorkshopTariff[];quotes:QuoteVersion[];approvals:QuoteApproval[]}>{
  const [tariffs,quotes,approvals]=await Promise.all([readRows<WorkshopTariff>('workshop_tariffs','*'),
    readRows<QuoteVersion>('estimate_versions','*'),readRows<QuoteApproval>('estimate_approvals','*')]);
  return{tariffs:tariffs.sort((a,b)=>a.code.localeCompare(b.code)||b.revision-a.revision),
    quotes:quotes.sort((a,b)=>b.created_at.localeCompare(a.created_at)),approvals};
}
export async function calculateQuote(lines:QuoteInput[],method:string,ratio:string|null,discount:string):Promise<QuoteCalculation>{
  return rpc('calculate_estimate',{lines,method,ratio,discount});
}
export async function estimateCommand<T>(command:'tariff'|'version'|'approve'|'reject',payload:Record<string,unknown>,key:string):Promise<T>{
  return rpc('execute_estimate_command',{command,payload,idempotency_key:key});
}
export function saveWorkshopQuote(payload:Record<string,unknown>,key:string):Promise<QuoteVersion>{
  return rpc('save_workshop_quote',{payload,idempotency_key:key});
}
export interface StoredPdf {id:string;hash:string;base64:string;}
export async function quotePdf(quote:QuoteVersion,base64?:string):Promise<StoredPdf|null>{
  return rpc('estimate_pdf',{estimate_id:quote.id,expected_status:quote.status,pdf_base64:base64??null});
}
