import {createSupabaseBrowserClient} from './client';
import {readRows} from './business';
import type {Customer} from '@/types';

export interface Receivable {id:string;customer_id:string;current_customer_id:string;customer_snapshot:Customer;reservation_id:string|null;order_id:string|null;description:string;amount:number;balance:number;due_on:string;days_overdue:number;aging_bucket:string;grouped?:boolean;external_reference?:string;folio_number?:number;}
export interface CustomerPayment {id:string;customer_id:string;amount:number;paid_on:string;method:string;account:string;reference:string;folio_number?:number;}
export interface PaymentApplication {id:string;payment_id:string;document_id:string;amount:number;kind:string;effective_on:string;reason:string;created_by:string;}
export interface PaymentRefund {id:string;payment_id:string;document_id:string|null;amount:number;refunded_on:string;reason:string;}
export const localToday=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
const messages:Record<string,string>={
  PERMISSION_DENIED:'No tiene permiso para esta acción.',PAYMENT_EXCEEDS_AVAILABLE_BALANCE:'El importe supera el saldo del documento o el pago disponible.',
  PAYMENT_CUSTOMER_MISMATCH:'El pago y el documento no pertenecen al mismo cliente.',
  INVALID_BILLING_AMOUNT_DATE:'Use un importe positivo con hasta dos decimales y una fecha válida, no futura.',
  BILLING_EVENT_OUT_OF_ORDER:'La fecha no puede ser anterior al último evento del pago o documento.',
  INVALID_CREDIT:'La nota de crédito necesita motivo y no puede superar el saldo sin aplicar.',
  REFUND_EXCEEDS_APPLICATION:'El reembolso supera lo aplicado a ese documento.',
  INTERNAL_VEHICLE_NOT_A_SALE:'La orden de un vehículo propio es costo interno, no una venta al negocio.',
  EXPLICIT_DOCUMENT_ALLOCATIONS_REQUIRED:'Reparta explícitamente el importe entre las líneas del documento.',
  DOCUMENT_LINE_BALANCE_EXCEEDED:'El importe supera el saldo o la aplicación de una de las líneas.',
  DOCUMENT_ALLOCATION_TOTAL_MISMATCH:'La distribución debe sumar el importe del movimiento.',
  DOCUMENT_CUSTOMER_MISMATCH:'Todas las operaciones deben pertenecer al cliente del documento.',
  DISCOUNT_REQUIRES_MANAGEMENT:'Los descuentos requieren autorización de gerencia.',
};
export async function billingRpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const {data,error}=await createSupabaseBrowserClient().rpc(name,args);
  if(error)throw new Error(messages[error.message]??'No se guardó el movimiento. Revise los importes, fechas, destino y conexión.');return data as T;
}
export async function loadBilling(cutoff:string){
  const [documents,payments,applications,refunds]=await Promise.all([
    billingRpc<Receivable[]>('receivables_at',{cutoff}),readRows<CustomerPayment>('customer_payments','*'),
    readRows<PaymentApplication>('payment_applications','*'),readRows<PaymentRefund>('payment_refunds','*')]);
  return{documents,payments,applications,refunds};
}
export type BillingCommand='issue'|'pay'|'apply'|'refund'|'credit';
export async function billingCommand(command:BillingCommand,payload:Record<string,unknown>,key:string):Promise<{id:string}>{
  return billingRpc('execute_billing_command',{command,payload,idempotency_key:key});
}
