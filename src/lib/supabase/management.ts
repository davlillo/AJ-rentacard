import {readRows} from './business';
import {workshopRpc} from './workshop';
import type {Reservation} from './reservations';

export interface RentalContract {id:string;reservation_id:string;revision:number;parent_id:string|null;booking_snapshot:Reservation;conditions:string;reason:string;created_at:string;}
export interface ContractAcceptance {id:string;contract_id:string;accepted_by:string;evidence:string;created_at:string;}
export interface CommissionRule {id:string;code:string;revision:number;rate:number;valid_from:string;valid_until:string;}
export interface CommissionEntry {id:string;reservation_id:string;seller_id:string;rule_id:string;cutoff:string;eligible_base:number;amount:number;}
export interface VehicleContribution {policy:string;vehicleId:string;plate:string;from:string;cutoff:string;income:{id:string;description:string;amount:number;date:string}[];
  costs:{id:string;order_id:string;description:string;amount:number;date:string}[];billedIncome:number;actualDirectCost:number;contribution:number;limitations:string;}
export async function loadContracts(reservationId:string){
  const [contracts,acceptances]=await Promise.all([readRows<RentalContract>('rental_contracts','*'),readRows<ContractAcceptance>('contract_acceptances','*')]);
  return{contracts:contracts.filter(c=>c.reservation_id===reservationId).sort((a,b)=>b.revision-a.revision),acceptances};
}
export async function contractCommand(command:'version'|'accept',payload:Record<string,unknown>,key:string):Promise<unknown>{return workshopRpc('execute_contract_command',{command,payload,idempotency_key:key});}
export async function storedContractPdf(contractId:string):Promise<{hash:string;base64:string}|null>{return workshopRpc('contract_pdf',{contract_id:contractId});}
export async function loadCommissions(){const [rules,entries]=await Promise.all([readRows<CommissionRule>('commission_rules','*'),readRows<CommissionEntry>('commission_entries','*')]);return{rules,entries};}
export async function commissionCommand(command:'rule'|'calculate'|'eligibility',payload:Record<string,unknown>,key:string):Promise<unknown>{return workshopRpc('execute_commission_command',{command,payload,idempotency_key:key});}
export async function vehicleContribution(vehicleId:string,from:string,cutoff:string):Promise<VehicleContribution>{return workshopRpc('vehicle_contribution',{vehicle_id:vehicleId,from_date:from,cutoff});}
