import {workshopRpc} from './workshop';
import {readRows} from './business';

export interface CostAnswer {requiresSelection:boolean;vehicleId:string;plate:string;operationId?:string;cutoff:string;total?:number;operations?:{id:string;service:string}[];sources?:{id:string;order_id:string;expense_id:string|null;description:string;amount:number}[];}
export interface ExpenseProposal {id:string;payload:Record<string,string|null>;payload_hash:string;expires_at:string;result:{id:string}|null;}
export interface AdministrationUser {id:string;email:string;roles:string[];}
export interface OperatingBudget {id:string;name:string;area:string;category:string;authorized:number;}
export interface BudgetPosition {authorized:number;committed:number;executed:number;available:number;cutoff:string;sources:{id:string;kind:string;amount:number}[];}
export interface IntegrationEvent {id:string;source:string;external_id:string;state:string;attempts:number;last_error:string|null;result:{id:string}|null;}
export interface ReportJob {id:string;cutoff:string;recipient_email:string;state:string;message_id:string|null;filters:Record<string,string>;}
export async function agentCost(vehicleRef:string,orderRef:string|null,cutoff:string):Promise<CostAnswer>{return workshopRpc('agent_vehicle_cost',{vehicle_ref:vehicleRef,order_ref:orderRef,cutoff});}
export async function proposeExpense(payload:Record<string,unknown>,key:string):Promise<ExpenseProposal>{return workshopRpc('propose_agent_expense',{payload,idempotency_key:key});}
export async function confirmExpense(proposal:ExpenseProposal):Promise<{id:string}>{return workshopRpc('confirm_agent_expense',{proposal_id:proposal.id,expected_hash:proposal.payload_hash});}
export async function administrationUsers():Promise<AdministrationUser[]>{return workshopRpc('administration_users',{});}
export async function administrationCommand(command:string,payload:Record<string,unknown>,key:string):Promise<unknown>{return workshopRpc('execute_administration_command',{command,payload,idempotency_key:key});}
export async function optionalCommand(command:string,payload:Record<string,unknown>,key:string):Promise<unknown>{return workshopRpc('execute_optional_command',{command,payload,idempotency_key:key});}
export async function reportDeliveryCommand(command:string,payload:Record<string,unknown>,key:string):Promise<unknown>{return workshopRpc('execute_report_delivery_command',{command,payload,idempotency_key:key});}
export async function budgetPosition(budgetId:string,cutoff:string):Promise<BudgetPosition>{return workshopRpc('budget_position',{budget_id:budgetId,cutoff});}
export async function loadControl(){const [users,budgets,events,jobs]=await Promise.all([administrationUsers(),readRows<OperatingBudget>('operating_budgets','*'),readRows<IntegrationEvent>('integration_inbox','*'),readRows<ReportJob>('report_outbox','*')]);return{users,budgets,events,jobs};}
