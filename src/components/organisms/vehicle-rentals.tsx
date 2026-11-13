'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {folio} from '@/controladores/folios';
import {groupVehicleRentals,rentalWorkflow,rentalSectionHref} from '@/controladores/rental-workflow';
import {loadRentalCase,type CaseFile} from '@/lib/supabase/cases';
import type {Reservation} from '@/lib/supabase/reservations';
import {RentalDates,RentalOperation} from './rental-operation';

export function VehicleRentals({file,onChange}:{file:CaseFile;onChange:()=>Promise<void>}){
  const groups=groupVehicleRentals(file.reservations,file.commitments);const focus=groups.focus;
  const [current,setCurrent]=useState<CaseFile|null>(null);const [error,setError]=useState('');const [retry,setRetry]=useState(0);
  useEffect(()=>{let active=true;setError('');
    if(focus)void loadRentalCase(focus.id).then(result=>{if(active)setCurrent(result);}).catch(error=>{if(active)setError(error.message);});
    return()=>{active=false;};
  },[focus?.id,file,retry]);
  // Refresh the same operation in place so the periodic workspace refresh keeps receipt drafts.
  const scoped=current?.reservations[0]?.id===focus?.id&&current?.vehicle.id===file.vehicle.id?current:null;
  function record(booking:Reservation){const state=rentalWorkflow(booking,file.commitments);
    return <article key={booking.id} className="rental-record"><div className="rental-record-heading"><h3>{folio('ALQ',booking.folio_number)} · {booking.customer_snapshot.name}</h3>
      <Badge tone={state.tone}>{state.label}</Badge></div><RentalDates booking={booking}/>
      <Link className="text-link" href={rentalSectionHref(booking.id,state.action==='depart'?'Salida y devolución':state.action==='clean'?'Limpieza':'Resumen')}>
        {state.action==='depart'?'Preparar entrega':state.action==='clean'?'Revisar limpieza':'Abrir alquiler'} →</Link></article>;
  }
  const title=focus?.rental_state==='Entregado'?'Alquiler actual':focus&&groups.returned.some(r=>r.id===focus.id)?'Devolución por finalizar':'Próxima reserva';
  return <div className="vehicle-rentals">
    {focus?(scoped?<RentalOperation key={focus.id} file={scoped} title={title} onChange={onChange}/>:
      <section className="panel p-5" aria-label="Operación del vehículo">{error?<><p role="alert" className="form-error">{error}</p>
        <Button variant="outline" onClick={()=>setRetry(value=>value+1)}>Reintentar consulta del alquiler</Button></>:<p role="status">Consultando {folio('ALQ',focus.folio_number)} y su saldo…</p>}</section>):
      <section className="panel p-5"><h2 className="font-semibold">Sin alquiler en curso</h2><p className="field-hint mt-2">Las operaciones devueltas se conservan en el historial.</p>
        <Link className="text-link" href="/calendario/">Consultar agenda o crear una reserva →</Link></section>}
    {error&&scoped&&<p className="form-error" role="alert">No se pudo actualizar el alquiler. {error} <button className="text-link" onClick={()=>setRetry(value=>value+1)}>Reintentar consulta</button></p>}
    {groups.active.filter(r=>r.id!==focus?.id).map(record)}
    {groups.returned.filter(r=>r.id!==focus?.id).map(record)}
    {groups.reserved.some(r=>r.id!==focus?.id)&&<section className="panel rental-record-list" aria-label="Reservas por entregar"><h2>Reservas por entregar</h2>
      {groups.reserved.filter(r=>r.id!==focus?.id).map(record)}</section>}
    {groups.drafts.some(r=>r.id!==focus?.id)&&<section className="panel rental-record-list"><h2>Reservas sin confirmar</h2>{groups.drafts.filter(r=>r.id!==focus?.id).map(record)}</section>}
    {!!groups.history.length&&<details className="panel rental-record-list"><summary>Historial de alquileres · {groups.history.length}</summary>{groups.history.map(record)}</details>}
  </div>;
}
