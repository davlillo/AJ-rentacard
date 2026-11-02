import {createSupabaseBrowserClient} from './client';
import {readRows} from './business';

export interface WorkshopCost {
  id:string;order_id:string;kind:string;description:string;quantity:number;unit_cost:number;amount:number;
  expense_id:string|null;linked_expense_id?:string|null;supplier:string;source_reference:string;disposition:string;estimate_id:string|null;
  version:number;reason:string;occurred_at:string;created_by:string;created_at:string;
}
const messages:Record<string,string>={
  PERMISSION_DENIED:'No tiene permiso para esta acción.',ORDER_NOT_OPEN:'La orden no está abierta.',
  VERSION_CONFLICT:'El registro cambió. Actualice antes de guardar.',
  IDEMPOTENCY_CONFLICT:'La solicitud ya se utilizó con otros datos.',
  APPROVED_SCOPE_REQUIRED:'Seleccione una versión aprobada de la misma orden.',
  COST_REASON_REQUIRED:'Indique el motivo de la clasificación.',
  INTERNAL_VEHICLE_NOT_A_SALE:'Un vehículo propio requiere costo interno o absorbido, no una venta al negocio.',
  INVALID_COST_PRECISION:'Use hasta cuatro decimales en cantidad y costo unitario.',
  DIRECT_PURCHASE_OVERPAYMENT:'El pago supera el saldo pendiente de esta compra.',
  DIRECT_PURCHASE_PAYMENT_REQUIRED:'Esta referencia pertenece a una compra directa. Registre su pago desde Costos de la orden.',
  DIRECT_PURCHASE_DESTINATION_MISMATCH:'El pago debe pertenecer a la misma orden que la compra.',
  INVALID_DATE:'La fecha debe ser válida, no futura y no anterior a la compra.',
  INVALID_AMOUNT:'Indique un importe positivo con un máximo de dos decimales.',
  CONTRACT_TEXT_ENCODING_UNSUPPORTED:'El PDF admite caracteres latinos. Revise los símbolos no compatibles de esta versión.',
  DOCUMENT_TOO_LARGE:'El documento excede el tamaño permitido.',
  WORKER_HAS_OPEN_TIMER:'Ya existe un cronómetro abierto o activo para este técnico. Pause o finalice el anterior.',
  TIME_REQUIRES_ASSIGNED_ACTIVE_TASK:'Solo el responsable puede iniciar tiempo en una tarea en proceso.',
  INVALID_TIMER_TRANSITION:'El cronómetro cambió de estado. Actualice la vista.',
  ONLY_FINISHED_TIME_CAN_BE_CORRECTED:'Finalice el cronómetro antes de corregir sus tramos.',
  TIME_REASON_REQUIRED:'Indique el motivo de la corrección.',
  INVALID_TIME_RANGE:'El tramo debe estar dentro del inicio y fin reales, sin fechas futuras.',
  TIME_OVERLAP:'La corrección se superpone con otro tramo del mismo técnico.',
  DELIVERY_HAS_OPEN_TIMERS:'Finalice todos los cronómetros antes de entregar, incluso con excepción.',
  DELIVERY_HAS_PENDING_ITEMS:'Hay costos pendientes, tareas abiertas o un alcance sin decisión. Resuelva la lista o solicite excepción a gerencia.',
  DELIVERY_EXCEPTION_REQUIRES_MANAGEMENT:'Solo gerencia puede autorizar una entrega por excepción.',
  DELIVERY_EXCEPTION_REASON_REQUIRED:'La excepción requiere un motivo y queda registrada con su responsable.',
  DELIVERY_REQUIRES_CREDIT_AUTHORIZATION:'El importe estimado pendiente requiere una autorización de crédito de gerencia con motivo.',
  ACKNOWLEDGE_PENDING_RECEPTION:'Confirme que revisó los datos de recepción aún pendientes. No se completarán automáticamente.',
  DELIVERY_ADJUSTMENT_REQUIRES_MANAGEMENT:'Solo gerencia puede registrar ajustes posteriores a la entrega.',
  DELIVERED_ORDER_REQUIRED:'El ajuste requiere una orden entregada con acta registrada.',
};
export async function workshopRpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const {data,error}=await createSupabaseBrowserClient().rpc(name,args);
  if(error)throw new Error(messages[error.message]??(error.code==='23505'
    ?'La referencia de compra ya existe. Revise el proveedor y la factura/línea.'
    :'No se pudo guardar. Revise los datos y la conexión.'));
  return data as T;
}
export async function loadCosts(orderId:string):Promise<WorkshopCost[]>{
  // Paginate using a stable primary key, matching the rest of the shared data adapter.
  return(await readRows<WorkshopCost>('workshop_costs','*')).filter(cost=>cost.order_id===orderId);
}
export async function costCommand(command:'purchase'|'classify',payload:Record<string,unknown>,key:string,afterDelivery=false):Promise<WorkshopCost>{
  return workshopRpc(afterDelivery?'execute_delivery_cost_adjustment':'execute_cost_command',{command,payload,idempotency_key:key});
}
export interface DirectPurchasePayment {id:string;direct_purchase_cost_id:string;amount:number;date:string;}
export async function loadPurchasePayments(orderId:string):Promise<DirectPurchasePayment[]>{
  const rows=await readRows<DirectPurchasePayment&{operation_id:string}>('expenses','id,direct_purchase_cost_id,amount,date,operation_id');
  return rows.filter(row=>row.operation_id===orderId&&row.direct_purchase_cost_id);
}
export async function payDirectPurchase(costId:string,payload:Record<string,unknown>,key:string):Promise<DirectPurchasePayment>{
  return workshopRpc('pay_direct_purchase',{cost_id:costId,payload,idempotency_key:key});
}
export interface TaskTimer {id:string;task_id:string;worker_id:string;state:'Activo'|'Pausado'|'Finalizado';started_at:string;finished_at:string|null;version:number;}
export interface TimeSpan {id:string;timer_id:string;started_at:string;ended_at:string|null;active_seconds:number|null;version:number;reason:string;updated_by:string;}
export type TimeCommand='start'|'pause'|'resume'|'finish'|'correct';
export async function loadTaskTime(taskId:string):Promise<{timers:TaskTimer[];spans:TimeSpan[]}>{
  const timers=(await readRows<TaskTimer>('task_timers','*')).filter(timer=>timer.task_id===taskId);
  const ids=new Set(timers.map(timer=>timer.id));
  return{timers,spans:(await readRows<TimeSpan>('task_time_spans','*')).filter(span=>ids.has(span.timer_id))};
}
export async function timeCommand(command:TimeCommand,payload:Record<string,unknown>,key:string):Promise<unknown>{
  return workshopRpc('execute_time_command',{command,payload,idempotency_key:key});
}
export interface DeliveryChecklist {
  orderId:string;version:number;status:string;pendingFields:string[];costs:WorkshopCost[];pendingCosts:number;
  openTasks:{id:string;description:string;status:string}[];openTimers:TaskTimer[];pendingEstimate:string|null;
  approvedEstimateId:string|null;estimatedUnpaid:number;balancePolicy:string;
}
export interface WorkshopDelivery {
  id:string;order_id:string;recipient:string;evidence:string;exception:boolean;reason:string;credit_reason:string;
  checklist:DeliveryChecklist;responsible_id:string;created_at:string;
}
export async function deliveryChecklist(orderId:string):Promise<DeliveryChecklist>{return workshopRpc('workshop_delivery_checklist',{order_id:orderId});}
export async function deliverOrder(payload:Record<string,unknown>,key:string):Promise<WorkshopDelivery>{return workshopRpc('deliver_workshop_order',{payload,idempotency_key:key});}
export async function loadDelivery(orderId:string):Promise<WorkshopDelivery|undefined>{return(await readRows<WorkshopDelivery>('workshop_deliveries','*')).find(delivery=>delivery.order_id===orderId);}
