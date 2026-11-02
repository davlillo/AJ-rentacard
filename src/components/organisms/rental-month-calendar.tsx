'use client';
import {useState} from 'react';
import {ChevronLeft,ChevronRight,CalendarDays} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {VehicleImage} from './vehicle-image';
import {Pagination,usePagination} from './pagination';
import {monthDays,shiftMonth,intersectsDay,calendarDate} from '@/controladores/month-calendar';
import type {Vehicle} from '@/types';
import type {Reservation,Commitment} from '@/lib/supabase/reservations';

export function RentalMonthCalendar({vehicles,reservations,commitments,onOpen,onBlock}:{
  vehicles:Vehicle[];reservations:Reservation[];commitments:Commitment[];onOpen:(id:string)=>void;onBlock:(block:Commitment)=>void;
}){
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
  const [month,setMonth]=useState(today.slice(0,7));const [selected,setSelected]=useState('');const [expandedDay,setExpandedDay]=useState('');
  const days=monthDays(month);const fleetIds=new Set(vehicles.map(v=>v.id));
  const bookings=reservations.filter(r=>fleetIds.has(r.vehicle_id)&&r.status!=='Cancelada').sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  const page=usePagination(bookings,vehicles.map(v=>v.id).join(','),8);
  const selection=bookings.find(r=>r.id===selected);
  const events=[...bookings.filter(r=>r.status==='Confirmada'&&['Preparado','Entregado'].includes(r.rental_state)).map(r=>({id:r.id,vehicleId:r.vehicle_id,start:r.starts_at,end:r.ends_at,
    kind:r.rental_state==='Preparado'?'Reservado':'Alquilado',customer:r.customer_snapshot.name})),
    ...commitments.filter(c=>c.active&&c.kind!=='Reserva'&&fleetIds.has(c.vehicle_id)).map(c=>({id:c.id,vehicleId:c.vehicle_id,
      start:c.starts_at,end:c.ends_at,kind:c.kind,customer:c.reason}))];
  const period=(start:string,end:string)=>`${new Date(start).toLocaleDateString('es-SV',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'America/El_Salvador'})} → ${end==='infinity'?'Sin fecha final':new Date(end).toLocaleDateString('es-SV',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'America/El_Salvador'})}`;
  function select(id:string,focusStart=true){const booking=bookings.find(r=>r.id===id);if(!booking)return;
    setSelected(id);if(focusStart)setMonth(calendarDate(booking.starts_at).slice(0,7));}
  return <div className="rental-calendar-layout"><section className="panel month-calendar" aria-label="Calendario mensual de vehículos">
    <header><div><span className="section-kicker">DISPONIBILIDAD DE LA FLOTA</span><h2>{new Date(month+'-01T12:00:00Z').toLocaleDateString('es-SV',{month:'long',year:'numeric',timeZone:'America/El_Salvador'})}</h2></div>
      <div className="month-calendar-controls"><button aria-label="Mes anterior" onClick={()=>setMonth(shiftMonth(month,-1))}><ChevronLeft size={18}/></button>
        <button onClick={()=>setMonth(today.slice(0,7))}>Hoy</button><button aria-label="Mes siguiente" onClick={()=>setMonth(shiftMonth(month,1))}><ChevronRight size={18}/></button></div></header>
    <div className="calendar-weekdays" aria-hidden="true">{['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d=><span key={d}>{d}</span>)}</div>
    <div className="calendar-month-grid" role="grid" aria-label={month}>{days.map(day=>{
      const entries=events.filter(e=>intersectsDay(day,e.start,e.end));
      const inRange=selection&&intersectsDay(day,selection.starts_at,selection.ends_at);
      return <div role="gridcell" key={day} data-date={day} aria-selected={!!inRange}
        className={`calendar-day ${day.slice(0,7)!==month?'calendar-day-outside ':''}${inRange?'calendar-day-selected ':''}${day===today?'calendar-day-today':''}`}>
        <span className="calendar-day-number">{Number(day.slice(8))}</span><div className="calendar-day-events">{(expandedDay===day?entries:entries.slice(0,2)).map(e=>{
          const car=vehicles.find(v=>v.id===e.vehicleId);return <button key={e.id} className={`calendar-event calendar-event-${e.kind==='Reservado'?'reserved':e.kind==='Alquilado'?'rented':'blocked'}`}
            aria-label={`${car?.plate} · ${e.kind} · ${e.customer} · ${day}`} title={`${car?.plate} · ${e.kind} · ${e.customer}`}
            onClick={()=>{if(bookings.some(r=>r.id===e.id))select(e.id,false);else{const block=commitments.find(c=>c.id===e.id);if(block)onBlock(block);}}}><strong>{car?.plate||car?.model}</strong><span>{e.customer}</span></button>;
        })}{entries.length>2&&<button className="calendar-more" aria-label={`Ver ${expandedDay===day?'menos':'todos los'} eventos del ${day}`}
          aria-expanded={expandedDay===day} onClick={()=>setExpandedDay(expandedDay===day?'':day)}>{expandedDay===day?'Ver menos':`+${entries.length-2} más`}</button>}</div>
      </div>;
    })}</div>
    <footer className="calendar-legend"><span><i className="legend-reserved"/>Reservado</span><span><i className="legend-rented"/>Alquilado</span><span><i className="legend-blocked"/>Taller / bloqueo</span></footer>
  </section><aside className="panel calendar-reservations" aria-label="Reservas por vehículo"><header><CalendarDays size={19}/><div><h2>Reservas y alquileres</h2><p>Seleccione uno para marcar sus fechas.</p></div></header>
    <div>{page.items.map(r=>{const car=vehicles.find(v=>v.id===r.vehicle_id);return <article key={r.id} className={selected===r.id?'calendar-booking selected':'calendar-booking'}>
      <button className="calendar-booking-select" aria-pressed={selected===r.id} onClick={()=>select(r.id)}>
        <VehicleImage vehicleId={r.vehicle_id} plate={car?.plate??''} fileId={car?.primaryPhotoId} size="thumbnail"/>
        <div><strong>{car?.plate||'Sin placa'} · {car?.brand} {car?.model}</strong><span>{r.customer_snapshot.name}</span></div>
      </button><div className="calendar-booking-period">{period(r.starts_at,r.ends_at)}</div>
      <div className="calendar-booking-bottom"><Badge tone={r.status==='Borrador'||['Devuelto','Cerrado'].includes(r.rental_state)?'gray':r.rental_state==='Preparado'?'amber':'blue'}>{r.status==='Borrador'?'Borrador':r.rental_state==='Preparado'?'Reservado':r.rental_state==='Entregado'?'Alquilado':r.rental_state}</Badge>
        <button className="text-link" onClick={()=>onOpen(r.id)}>Ver reserva →</button></div>
      {r.status==='Borrador'&&<small>El borrador no bloquea fechas hasta confirmarlo.</small>}
    </article>;})}{!bookings.length&&<div className="calendar-no-bookings"><CalendarDays size={30}/><h3>Aún no hay reservas</h3><p>Las reservas confirmadas aparecerán en el calendario con su vehículo, cliente y fechas.</p></div>}</div>
    <Pagination {...page}/>{selection&&<div className="calendar-selection-note"><strong>Fechas seleccionadas</strong><p>{period(selection.starts_at,selection.ends_at)}</p>
      <Button variant="outline" size="sm" onClick={()=>setSelected('')}>Quitar selección</Button></div>}
  </aside></div>;
}
