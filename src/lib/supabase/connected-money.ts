import {createSupabaseBrowserClient} from './client';
import type {CaseExpense} from './cases';
import type {QuoteVersion} from './estimates';

export interface ExpenseAllocation {orderId:string;amount:string;}
export interface UnlinkedExpense extends CaseExpense {method:string;category:string;}
const messages:Record<string,string>={
  PERMISSION_DENIED:'No tiene permiso para registrar o asociar movimientos.',
  EXPENSE_LINK_DETAILS_REQUIRED:'Seleccione los trabajos e indique el motivo del vínculo.',
  EXPENSE_NOT_AVAILABLE_TO_LINK:'Este gasto ya tiene otro destino. No se modificó su movimiento original.',
  EXPENSE_ALREADY_LINKED:'El gasto ya está asociado. Actualice para consultar sus vínculos; no vuelva a registrarlo.',
  DUPLICATE_EXPENSE_DESTINATION:'Seleccione cada trabajo una sola vez en el reparto.',
  EXPENSE_ALLOCATION_TOTAL_MISMATCH:'Los importes repartidos deben sumar exactamente el gasto original.',
  INVALID_AMOUNT:'Use importes positivos con un máximo de dos decimales.',
  PAYMENT_CUSTOMER_MISMATCH:'El cliente no coincide con el trabajo, cargo o recibo elegido.',
  CASE_DOCUMENT_REQUIRED:'Seleccione un cargo de esta operación para aplicar el recibo existente.',
  PAYMENT_EXCEEDS_AVAILABLE_BALANCE:'El importe supera el saldo del cargo o el dinero disponible del recibo.',
  INVALID_BILLING_AMOUNT_DATE:'Revise el importe y la fecha efectiva; no se admiten fechas futuras.',
  APPLICATION_PREDATES_PAYMENT:'La aplicación no puede ser anterior al recibo.',
  APPLICATION_PREDATES_DOCUMENT:'La aplicación no puede ser anterior al cargo.',
  BILLING_EVENT_OUT_OF_ORDER:'Use una fecha no anterior a los últimos movimientos del cargo y recibo.',
  DELIVERY_ADJUSTMENT_REQUIRES_MANAGEMENT:'Solo gerencia puede asociar un gasto a un trabajo ya entregado.',
  IDEMPOTENCY_CONFLICT:'Los datos cambiaron respecto al intento anterior. Actualice antes de continuar.',
  VERSION_CONFLICT:'El costo cambió mientras preparaba el presupuesto. Revise el costo actual antes de incorporarlo.',
  PARENT_VERSION_CONFLICT:'Ya existe una versión más reciente. Ábrala antes de preparar otra revisión.',
  ESTIMATE_LINE_MISMATCH:'El costo de origen debe pertenecer a este trabajo.',
  DUPLICATE_COST_ORIGIN:'El mismo costo no puede incorporarse dos veces en esta versión.',
  INTERNAL_VEHICLE_NOT_A_SALE:'El mantenimiento interno no recibe cobros de clientes.',
};
export async function moneyRpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const {data,error}=await createSupabaseBrowserClient().rpc(name,args);
  if(error)throw new Error(messages[error.message]??'No se completó el movimiento. Revise los datos y reintente; no lo registre otra vez en otra pantalla.');
  return data as T;
}
export function recordLinkedExpense(payload:Record<string,unknown>,key:string):Promise<unknown>{
  return moneyRpc('record_linked_expense',{payload,idempotency_key:key});
}
export function linkWorkshopExpense(payload:Record<string,unknown>,key:string):Promise<unknown>{
  return moneyRpc('link_workshop_expense',{payload,idempotency_key:key});
}
export function recordLinkedReceipt(payload:Record<string,unknown>,key:string):Promise<unknown>{
  return moneyRpc('record_linked_receipt',{payload,idempotency_key:key});
}
export function loadExpenseInbox():Promise<UnlinkedExpense[]>{return moneyRpc('workshop_expense_inbox',{});}
export function recordConnectedQuote(payload:Record<string,unknown>,key:string):Promise<QuoteVersion>{
  return moneyRpc('record_connected_quote',{payload,idempotency_key:key});
}
