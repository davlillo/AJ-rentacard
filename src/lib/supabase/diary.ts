import {billingRpc} from './billing';
export interface DiaryLink {orderId:string|null;reservationId:string|null;amount:number;kind:string;}
export interface DiaryRow {
  id:string;date:string;kind:string;concept:string;amount:number;account:string|null;counter_account:string|null;
  area:string;destination:string;source_type:string;inflow:number;outflow:number;balance_effect:number;
  links?:DiaryLink[];linkable?:boolean;unapplied_amount?:number;customer_id?:string|null;folio_number?:number|null;
}
export interface CashDiary {
  rows:DiaryRow[];income:number;outgoing:number;netMovement:number;balanceBefore:number|null;balanceAfter:number|null;
  hasOpening:boolean;unassignedRefunds:number;accounts:string[];policy:string;
}
export function loadDiary(from:string,to:string,account?:string):Promise<CashDiary>{
  return billingRpc('cash_diary',{from_date:from,to_date:to,account_filter:account||null});
}
export function recordCashEntry(payload:Record<string,unknown>,key:string):Promise<unknown>{
  return billingRpc('record_cash_entry',{payload,idempotency_key:key});
}
