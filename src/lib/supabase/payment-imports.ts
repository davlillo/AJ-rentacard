import {workshopRpc} from './workshop';
import {readRows} from './business';

export interface PaymentImportRow {rowNumber:string;status:string;payload:Record<string,string|null>|null;paymentId:string|null;candidates:string[];similarRows?:string[];error:string|null;}
export interface PaymentImport {id:string;file_name:string;file_hash:string;sheet:string;rows:{rowNumber:number;cells:Record<string,string|number>;hasFormula:boolean}[];mapping:Record<string,string>;source_system:string;
  decisions:Record<string,{action?:string;reason?:string;paymentId?:string}>;preview:PaymentImportRow[];new_total:number;status:'Preparado'|'Validado'|'Publicado';version:number;}
export async function paymentImportCommand(command:'stage'|'validate'|'commit',payload:Record<string,unknown>,key:string):Promise<PaymentImport>{return workshopRpc('execute_payment_import',{command,payload,idempotency_key:key});}
export async function paymentImports():Promise<PaymentImport[]>{return(await readRows<PaymentImport>('payment_imports','*')).reverse();}
export async function paymentImportOriginal(batchId:string):Promise<string>{return workshopRpc('payment_import_original',{batch_id:batchId});}
