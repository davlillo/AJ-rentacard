import type {BusinessData, Customer, Vehicle, WorkOrder, Movement, WorkshopTask, ReservationHistory} from '@/types';
import {createSupabaseBrowserClient} from './client';

export type BusinessCommand = 'create_customer' | 'merge_customer' | 'create_vehicle' |
  'receive_vehicle' | 'record_expense';
export interface CommandResult {id: string; command: BusinessCommand; createdAt: string;}
export const emptyBusiness: BusinessData = {
  customers: [], vehicles: [], orders: [], movements: [], rentals: [], items: [], estimates: [],
};

const messages: Record<string, string> = {
  PERMISSION_DENIED: 'Tu usuario no tiene permiso para esta acción.',
  CUSTOMER_MATCH_EXISTS: 'Ya existe un cliente con ese teléfono o documento. Revisá las coincidencias.',
  IDEMPOTENCY_CONFLICT: 'Esta solicitud ya se usó con otros datos. Abrí un nuevo formulario.',
  VERSION_CONFLICT: 'Los clientes cambiaron. Actualizá la página antes de fusionarlos.',
  INVALID_MERGE: 'Seleccioná dos clientes activos distintos e indicá el motivo.',
  VEHICLE_UNAVAILABLE: 'El vehículo ya tiene un compromiso o no está disponible.',
  INVALID_OPERATION: 'La operación no existe o está cerrada.',
  INVALID_CUSTOMER: 'El cliente ya no está activo.',
  INVALID_OWNER: 'Seleccioná un propietario activo.',
  DIRECT_PURCHASE_PAYMENT_REQUIRED: 'Esta referencia ya es una compra directa. Registre su pago en Costos de la orden para no duplicarlo.',
  INTERNAL_FLEET_VEHICLE_REQUIRED: 'El mantenimiento interno requiere un vehículo de la flota disponible.',
};

export async function executeCommand(
  command: BusinessCommand, payload: Record<string, unknown>, key: string,
): Promise<CommandResult> {
  const {data, error} = await createSupabaseBrowserClient().rpc('execute_command', {
    command, payload, idempotency_key: key,
  });
  if (error) throw new Error(messages[error.message] ?? 'No se guardó el registro. Revisá los datos o la conexión.');
  return data as CommandResult;
}

// Do not silently truncate the registry at PostgREST's max_rows.
export async function readRows<T>(table: string, columns: string, order = 'id'): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const {data, error,status} = await createSupabaseBrowserClient().from(table)
      .select(columns).order(order).range(offset, offset + 499).returns<T[]>();
    if(error)throw new Error('No se pudieron cargar los datos compartidos.',{
      cause:{code:error.code,status,resource:table},
    });
    result.push(...data);
    if (data.length < 500) return result;
  }
}

interface StoredCustomer extends Customer {merged_into: string | null;}
interface Expense {
  id: string; date: string; concept: string; amount: number; method: string;
  operation_id: string | null; cost_center_id: string | null;
  vehicle_id: string | null; reservation_id: string | null;
  category: string; account: string; currency: string; support: string; created_at: string; created_by: string;
}
interface Alias {source_id: string; customer_id: string; snapshot: Customer;}

export async function loadBusiness(): Promise<BusinessData> {
  const [customers, aliases, vehicles, orders, expenses, tasks, reservationHistory, photos] = await Promise.all([
    readRows<StoredCustomer>('customers', '*'),
    readRows<Alias>('customer_aliases', 'source_id,customer_id,snapshot', 'source_id'),
    readRows<Vehicle>('vehicles', '*,ownerCustomerId:owner_customer_id,inRentalFleet:in_rental_fleet,registeredHolder:registered_holder,commercialLine:commercial_line'),
    readRows<WorkOrder>('work_orders', '*,vehicleId:vehicle_id,customerId:customer_id,pendingFields:pending_fields,' +
      'occurredAt:occurred_at,createdAt:created_at,createdBy:created_by,internalJob:internal_job'),
    readRows<Expense>('expenses', '*'),
    readRows<WorkshopTask>('workshop_tasks', '*,orderId:order_id,assignedTo:assigned_to,assigneeLabel:assignee_label,createdAt:created_at'),
    readRows<ReservationHistory>('reservations','id,vehicleId:vehicle_id,customerId:customer_id,start:starts_at,end:ends_at,status,rentalState:rental_state'),
    readRows<{id:string;vehicle_id:string;mime:string;purpose:string;financial:boolean;created_at:string}>('vehicle_files','id,vehicle_id,mime,purpose,financial,created_at'),
  ]);
  return {
    ...emptyBusiness,
    customers: customers.filter(customer => !customer.merged_into).map(customer => ({
      ...customer, aliases: aliases.filter(alias => alias.customer_id === customer.id).map(alias => alias.snapshot),
    })),
    vehicles:vehicles.map(vehicle=>({...vehicle,primaryPhotoId:photos.filter(photo=>photo.vehicle_id===vehicle.id&&
      photo.mime.startsWith('image/')&&!photo.financial).sort((a,b)=>Number(b.purpose==='Vehículo')-Number(a.purpose==='Vehículo')||b.created_at.localeCompare(a.created_at))[0]?.id})),
    orders, tasks, reservationHistory,
    movements: expenses.map((expense): Movement => ({
      id: expense.id, date: expense.date, concept: expense.concept, amount: Number(expense.amount),
      method: expense.method, type: 'Egreso',
      area: expense.operation_id || expense.cost_center_id === 'workshop' ? 'Taller'
        : expense.cost_center_id === 'rental' || expense.reservation_id || expense.vehicle_id ? 'Renta' : 'Administración',
      operation: expense.operation_id ?? expense.reservation_id ?? expense.vehicle_id ?? expense.cost_center_id!,
      category: expense.category, account: expense.account, currency: expense.currency, support: expense.support,
      createdAt: expense.created_at, createdBy: expense.created_by,
    })),
  };
}
