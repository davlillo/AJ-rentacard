'use client';
import Link from 'next/link';
import {Badge} from '@/components/atoms/badge';
import {folio} from '@/controladores/folios';
import {groupVehicleRentals,rentalWorkflow,rentalSectionHref} from '@/controladores/rental-workflow';
import type {CaseFile} from '@/lib/supabase/cases';
import type {Reservation} from '@/lib/supabase/reservations';
import {RentalDates} from './rental-operation';
import styles from './vehicle-rentals.module.css';

export function VehicleRentals({file}:{file:CaseFile;onChange:()=>Promise<void>}){
  const groups=groupVehicleRentals(file.reservations,file.commitments);const focus=groups.focus;
  function record(booking:Reservation){const state=rentalWorkflow(booking,file.commitments);
    return <article key={booking.id} className="rental-record"><div className="rental-record-heading"><h3>{folio('ALQ',booking.folio_number)} · {booking.customer_snapshot.name}</h3>
      <Badge tone={state.tone}>{state.label}</Badge></div><RentalDates booking={booking}/>
      <Link className="text-link" href={rentalSectionHref(booking.id)}>Abrir folio →</Link></article>;
  }
  const title=focus?.rental_state==='Entregado'?'Alquiler actual':focus&&groups.returned.some(r=>r.id===focus.id)?'Devolución por finalizar':'Próxima reserva';
  return <div className={`vehicle-rentals ${styles.records}`}>
    <p className="inline-note">Consulta de alquileres de esta unidad. La entrega, la devolución y los cobros se gestionan dentro de cada folio.</p>
    {focus?<section className="panel rental-record-list" aria-label={title}><h2>{title}</h2>{record(focus)}</section>:
      <section className="panel p-5"><h2 className="font-semibold">Sin alquiler en curso</h2><p className="field-hint mt-2">Las operaciones devueltas se conservan en el historial.</p>
        <Link className="text-link" href="/alquileres/">Consultar folios y disponibilidad →</Link></section>}
    {groups.active.filter(r=>r.id!==focus?.id).map(record)}
    {groups.returned.filter(r=>r.id!==focus?.id).map(record)}
    {groups.reserved.some(r=>r.id!==focus?.id)&&<section className="panel rental-record-list" aria-label="Reservas por entregar"><h2>Reservas por entregar</h2>
      {groups.reserved.filter(r=>r.id!==focus?.id).map(record)}</section>}
    {groups.drafts.some(r=>r.id!==focus?.id)&&<section className="panel rental-record-list"><h2>Reservas sin confirmar</h2>{groups.drafts.filter(r=>r.id!==focus?.id).map(record)}</section>}
    {!!groups.history.length&&<details className="panel rental-record-list"><summary>Historial de alquileres · {groups.history.length}</summary>{groups.history.map(record)}</details>}
  </div>;
}
