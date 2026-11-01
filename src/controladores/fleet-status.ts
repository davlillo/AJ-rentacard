import type {ReservationHistory,Vehicle,VehicleStatus} from '@/types';

export type FleetStatus=VehicleStatus|'Reservado';

// Reservations are commitments, not a replacement for physical rental/workshop state.
export function fleetStatus(vehicle:Vehicle,reservations:ReservationHistory[],now=Date.now()):FleetStatus{
  if(vehicle.status!=='Disponible')return vehicle.status;
  const reserved=reservations.some(booking=>booking.vehicleId===vehicle.id&&booking.status==='Confirmada'&&
    booking.rentalState==='Preparado'&&Number.isFinite(Date.parse(booking.start))&&
    (booking.end==='infinity'||Date.parse(booking.end)>now));
  return reserved?'Reservado':'Disponible';
}
