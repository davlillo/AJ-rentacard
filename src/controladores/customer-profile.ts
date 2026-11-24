import type {BusinessData,Customer,Vehicle} from '@/types';
import type {Receivable} from '@/lib/supabase/billing';
import {folio} from './folios';

export const customerSections=['Operaciones','Vehículos','Datos y documentos','Cobros'] as const;
export type CustomerSection=typeof customerSections[number];
// A legacy section name keeps resolving: the profile used to call this section "Cargos y cobros".
export function customerSection(value:string|null):CustomerSection{
  if(value==='Cargos y cobros')return 'Cobros';
  return customerSections.find(section=>section===value)??'Operaciones';
}
export const customerWorkshopStages=['Presupuesto','Diagnóstico','En proceso','Control de calidad','Entregado'] as const;
export const customerRentalStages=['Borrador','Reservado','En alquiler','Devuelto','Cerrado','Cancelado','Por revisar'] as const;
export interface CustomerOperation {
  id:string;kind:'Taller'|'Alquiler';vehicleId:string;label:string;description:string;stage:string;
  href:string;active:boolean;date:string;
}

export function customerHref(id:string,section:CustomerSection='Operaciones'):string{
  return '/clientes/expediente/?'+new URLSearchParams({id,...(section==='Operaciones'?{}:{seccion:section})});
}

export function customerOperations(data:BusinessData,customerId:string):CustomerOperation[]{
  const workshop=data.orders.filter(order=>order.customerId===customerId).map((order):CustomerOperation=>({
    id:order.id,kind:'Taller',vehicleId:order.vehicleId,label:folio('OT',order.id),description:order.service,
    stage:order.status,href:'/taller/ingreso/?'+new URLSearchParams({id:order.id}),
    active:order.status!=='Presupuesto'&&order.status!=='Entregado',date:order.occurredAt??order.createdAt??'',
  }));
  const rentals=(data.reservationHistory??[]).filter(booking=>booking.customerId===customerId)
    .map((booking):CustomerOperation=>({id:booking.id,kind:'Alquiler',vehicleId:booking.vehicleId,
      label:folio('ALQ',booking.folioNumber),description:'Reserva / alquiler',
      stage:booking.status==='Cancelada'?'Cancelado':booking.status==='Borrador'?'Borrador':booking.status!=='Confirmada'?'Por revisar':
        ({Preparado:'Reservado',Entregado:'En alquiler',Devuelto:'Devuelto',Cerrado:'Cerrado'}[booking.rentalState]??'Por revisar'),
      active:booking.status==='Confirmada'&&booking.rentalState==='Entregado',
      href:'/vehiculos/alquiler/?'+new URLSearchParams({id:booking.id}),date:booking.start}));
  return [...workshop,...rentals].sort((a,b)=>Number(b.active)-Number(a.active)||b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
}

export function customerVehicles(vehicles:Vehicle[],operations:CustomerOperation[],customerId:string):Vehicle[]{
  const related=new Set(operations.map(operation=>operation.vehicleId));
  return vehicles.filter(vehicle=>vehicle.ownerCustomerId===customerId||related.has(vehicle.id));
}

export function customerDocumentsAt(documents:Receivable[],customerId:string):Receivable[]{
  // A preserved historical snapshot is not the current owner of a merged customer's debt.
  return documents.filter(document=>document.current_customer_id===customerId);
}

export function customerMissingFields(customer:Customer):string[]{
  return [[customer.phone,'Teléfono'],[customer.document,'Documento'],[customer.email,'Correo electrónico']]
    .filter(([value])=>!value?.trim()).map(([,label])=>label);
}
