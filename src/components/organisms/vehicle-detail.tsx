'use client';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {Badge, statusTone} from '@/components/atoms/badge';
import {VehicleArt} from '@/components/atoms/vehicle-art';
import {useBusiness} from '@/hooks/use-business';
import {money} from '@/controladores/finanzas';
import {dateLabel} from '@/controladores/reportes';
import {FileText, Wallet, Car} from 'lucide-react';

export function VehicleDetail({id, onClose}: {id: string | null; onClose: () => void}) {
  const {data, source, can} = useBusiness();
  const vehicle = data.vehicles.find(vehicle => vehicle.id === id);
  if (!vehicle) return null;
  const rentals = (source === 'supabase'
    ? (data.reservationHistory ?? []).map(rental => ({...rental,status:`${rental.status} · ${rental.rentalState}`}))
    : data.rentals).filter(rental => rental.vehicleId === id);
  const orders = data.orders.filter(order => order.vehicleId === id);
  const operationIds = new Set([...rentals, ...orders].map(operation => operation.id));
  const expenses = data.movements.filter(movement => operationIds.has(movement.operation) && movement.type === 'Egreso');
  const owner = data.customers.find(customer => customer.id === vehicle.ownerCustomerId);
  const events = [
    ...rentals.map(rental => ({id: rental.id, date: rental.start, title: `${rental.id} · Alquiler`,
      text: `${data.customers.find(customer => customer.id === rental.customerId)?.name ?? ''} · ${rental.status}`, icon: Car})),
    ...orders.map(order => ({id: order.id, date: order.occurredAt ?? order.due, title: `${order.id} · ${order.service}`,
      text: `${order.status} · ${order.technician}`, icon: FileText})),
    ...expenses.map(expense => ({id: expense.id, date: expense.date, title: expense.concept,
      text: `${expense.id} · ${expense.operation} · ${money(expense.amount)}`, icon: Wallet})),
  ].sort((first, second) => second.date.localeCompare(first.date));
  return <Dialog open onOpenChange={open => !open && onClose()}><DialogContent className="max-w-2xl">
    <div className="eyebrow">EXPEDIENTE DEL VEHÍCULO</div>
    <DialogTitle className="text-2xl font-semibold mt-2">{vehicle.brand} {vehicle.model}</DialogTitle>
    <DialogDescription className="text-sm text-muted-foreground mt-1">{vehicle.plate} · {vehicle.year} · {vehicle.category}</DialogDescription>
    <div className="detail-hero"><VehicleArt category={vehicle.category} color={vehicle.color} model={`${vehicle.brand} ${vehicle.model}`}/>
      <div><Badge tone={statusTone(vehicle.status)}>{vehicle.status}</Badge><p>{vehicle.km.toLocaleString()} km</p>
        <strong>{money(vehicle.daily)} <small>/ día</small></strong></div></div>
    <dl className="detail-list">
      <div><dt>Relación</dt><dd>{vehicle.ownership ?? 'Sin registrar'}</dd></div>
      <div><dt>Propietario</dt><dd>{vehicle.ownership === 'Propio' ? 'AJ Rent a Car' : owner?.name ?? 'Sin registrar'}</dd></div>
      <div><dt>VIN</dt><dd>{vehicle.vin || 'Sin registrar'}</dd></div>
    </dl>
    <div className="detail-metrics"><div><span>Alquileres</span><strong>{rentals.length}</strong></div>
      <div><span>Órdenes</span><strong>{orders.length}</strong></div>
      <div><span>Egresos registrados</span><strong>{can('expenses.read')
        ? money(expenses.reduce((sum, expense) => sum + expense.amount, 0)) : 'Restringido'}</strong></div></div>
    {source === 'supabase' && <p className="field-hint">Los egresos son gastos registrados, no el costo completo ni el saldo del vehículo.
      Cada operación conserva sus importes separados.</p>}
    <h3 className="font-semibold mt-6 mb-4">Historial y trazabilidad</h3>
    <div className="timeline">{events.map(event => <div className="timeline-item" key={event.id}>
      <div className="timeline-dot"><event.icon size={14}/></div><div><small>{dateLabel(event.date.slice(0, 10))}</small>
        <strong>{event.title}</strong><p>{event.text}</p></div>
    </div>)}</div>
    {orders.filter(order => order.pendingFields?.length).map(order => <section className="inline-note mt-3" key={order.id}>
      <strong>{order.id} · Datos pendientes</strong><p>{order.pendingFields!.join(', ')}</p>
    </section>)}
  </DialogContent></Dialog>;
}
