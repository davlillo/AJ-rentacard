'use client';
import Link from 'next/link';
import {useEffect,useState,type CSSProperties} from 'react';
import {ArrowLeft,ArrowRight,CalendarDays,ChevronLeft,ChevronRight,MoveRight} from 'lucide-react';
import {rentalTimeline,timelineDays,shiftTimelineDay,type TimelineEvent} from '@/controladores/rental-timeline';
import {calendarDate} from '@/controladores/month-calendar';
import {fleetStatus} from '@/controladores/fleet-status';
import {vehicleHref} from '@/lib/supabase/cases';
import type {Vehicle} from '@/types';
import type {Commitment,Reservation} from '@/lib/supabase/reservations';
import {VehicleImage} from './vehicle-image';
import styles from './rental-gantt.module.css';

const dateLabel=(value:string)=>new Date(value+'T12:00:00Z').toLocaleDateString('es-SV',{day:'numeric',month:'short',timeZone:'UTC'});
const fullDate=(value:string)=>value==='infinity'?'Sin fecha final':new Date(value).toLocaleString('es-SV',{
  day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'America/El_Salvador'});

export function RentalGantt({vehicles,reservations,commitments,from,onNavigate,onOpen,onBlock}:{
  vehicles:Vehicle[];reservations:Reservation[];commitments:Commitment[];from:string;onNavigate:(day:string)=>void;
  onOpen:(id:string)=>void;onBlock:(block:Commitment)=>void;
}){
  const [span,setSpan]=useState(14);const [compact,setCompact]=useState(false);
  const [kind,setKind]=useState('Todos');const [onlyBusy,setOnlyBusy]=useState(true);
  useEffect(()=>{const media=window.matchMedia('(max-width:640px)');const update=()=>setCompact(media.matches);
    update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const count=compact?7:span;const days=timelineDays(from,count);const today=calendarDate(new Date().toISOString());
  const allRows=rentalTimeline(vehicles,reservations,commitments,from,count);
  const rows=allRows.map(row=>({...row,events:row.events.filter(event=>kind==='Todos'||event.kind===kind)}))
    .filter(row=>kind!=='Todos'?row.events.length:!onlyBusy||row.events.length);
  const visibleEvents=rows.flatMap(row=>row.events);const todayIndex=days.indexOf(today);
  const histories=reservations.map(r=>({id:r.id,vehicleId:r.vehicle_id,customerId:r.customer_id,start:r.starts_at,end:r.ends_at,
    status:r.status,rentalState:r.rental_state}));
  function open(event:TimelineEvent){if(event.reservationId)onOpen(event.reservationId);else if(event.block)onBlock(event.block);}
  return <section className={styles.gantt} aria-label="Planificación Gantt de vehículos">
    <header className={styles.header}><div><span className={styles.kicker}>PLANIFICACIÓN POR VEHÍCULO</span>
      <h2>Una flota. Todo el recorrido.</h2><p>Alquileres y reservas sobre la misma línea de tiempo.</p></div>
      <div className={styles.period}><div className={styles.navigation}>
        <button type="button" aria-label="Período anterior del Gantt" onClick={()=>onNavigate(shiftTimelineDay(from,-count))}><ChevronLeft size={18}/></button>
        <button type="button" onClick={()=>onNavigate(today)}>Hoy</button>
        <button type="button" aria-label="Período siguiente del Gantt" onClick={()=>onNavigate(shiftTimelineDay(from,count))}><ChevronRight size={18}/></button></div>
        {!compact&&<div className={styles.zoom} aria-label="Escala del Gantt">{[7,14].map(value=><button type="button" key={value}
          aria-pressed={span===value} onClick={()=>setSpan(value)}>{value===7?'Semana':'Quincena'}</button>)}</div>}
      </div>
    </header>
    <div className={styles.toolbar}><div className={styles.range}><CalendarDays size={16}/><strong>{dateLabel(from)} <MoveRight size={14}/> {dateLabel(days.at(-1)??from)}</strong>
      <span>{rows.length} de {vehicles.length} vehículos</span></div>
      <div className={styles.filters}><label><span className="sr-only">Estado en el Gantt</span><select aria-label="Estado en el Gantt" value={kind} onChange={e=>setKind(e.target.value)}>
        <option value="Todos">Todos</option><option value="Alquilado">Alquilados</option><option value="Reservado">Reservados</option></select></label>
        <label className={styles.onlyBusy}><input type="checkbox" checked={onlyBusy} onChange={e=>setOnlyBusy(e.target.checked)}/>Solo con compromisos</label></div>
    </div>
    <div className={styles.schedule} style={{'--timeline-days':count} as CSSProperties}>
      <div className={styles.axis}><span>VEHÍCULO / ESTADO ACTUAL</span><div className={styles.days} aria-hidden="true">{days.map(day=><div key={day}
        className={day===today?styles.currentDay:''}><small>{new Date(day+'T12:00:00Z').toLocaleDateString('es-SV',{weekday:'short',timeZone:'UTC'})}</small><strong>{Number(day.slice(8))}</strong></div>)}</div></div>
      <div role="list" aria-label="Vehículos del Gantt">{rows.map(({vehicle,events})=><article role="listitem" key={vehicle.id} className={styles.row}>
        <div className={styles.identity}><VehicleImage vehicleId={vehicle.id} plate={vehicle.plate} fileId={vehicle.primaryPhotoId} size="thumbnail"/>
          <div><Link href={vehicleHref(vehicle.id)}>{vehicle.plate}<MoveRight size={13}/></Link><strong>{vehicle.brand} {vehicle.model}</strong>
            <span>{fleetStatus(vehicle,histories)}</span></div></div>
        <div className={styles.track}>
          {todayIndex>=0&&<div className={styles.todayLine} aria-hidden="true" style={{left:`${todayIndex/count*100}%`,width:`${100/count}%`}}/>}
          {!events.length?<p className={styles.free}>Sin compromisos registrados en este período</p>:events.map(event=><div key={event.id} className={styles.lane}>
            <button type="button" className={`${styles.bar} ${event.kind==='Alquilado'?styles.rented:event.kind==='Reservado'?styles.reserved:styles.blocked}`}
              style={{'--event-left':`${event.left}%`,width:`${event.width}%`} as CSSProperties}
              aria-label={`${vehicle.plate} · ${event.kind} · ${event.customer} · ${fullDate(event.startsAt)} a ${fullDate(event.endsAt)}`}
              title={`${event.kind} · ${event.customer}\n${fullDate(event.startsAt)} → ${fullDate(event.endsAt)}`} onClick={()=>open(event)}>
              {event.continuesBefore&&<ArrowLeft size={12}/>} {event.width>=24&&<span>{event.kind}</span>}{event.continuesAfter&&<ArrowRight size={12}/>}</button>
            <button type="button" className={styles.eventDetail} onClick={()=>open(event)}><strong>{event.kind} · {event.customer}</strong><span>{fullDate(event.startsAt)} → {fullDate(event.endsAt)}</span></button>
          </div>)}
        </div>
      </article>)}</div>
      {!rows.length&&<div className={styles.empty}><CalendarDays size={26}/><h3>No hay compromisos en esta vista</h3><p>Cambie el período o muestre todos los vehículos. No se deduce disponibilidad histórica de una celda vacía.</p></div>}
    </div>
    <footer className={styles.footer}><div className={styles.legend} aria-label="Leyenda del Gantt"><span><i className={styles.rentedDot}/>Alquilado <strong>{visibleEvents.filter(e=>e.kind==='Alquilado').length}</strong></span>
      <span><i className={styles.reservedDot}/>Reservado <strong>{visibleEvents.filter(e=>e.kind==='Reservado').length}</strong></span><span><i className={styles.todayDot}/>Hoy</span></div>
      <p>Seleccione una barra para abrir su operación. Las flechas indican continuidad fuera del período.</p></footer>
  </section>;
}
