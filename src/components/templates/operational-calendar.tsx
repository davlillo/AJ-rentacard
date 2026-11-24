'use client';
import {Suspense,useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {CalendarioScreen} from './calendario-screen';
import {loadCalendar,reservationCommand,salvadorDateTime,type Reservation,type Commitment,type ReservationEvidence,type ReservationCommand,type RentalInspection} from '@/lib/supabase/reservations';
import {readRows} from '@/lib/supabase/business';
import {money} from '@/controladores/finanzas';
import styles from './operational-calendar.module.css';
import {WorkbookPreview} from '@/components/organisms/workbook-preview';
import {vehicleHref,orderHref,rentalHref} from '@/lib/supabase/cases';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {folio} from '@/controladores/folios';
import {RentalMonthCalendar} from '@/components/organisms/rental-month-calendar';
import {RentalGantt} from '@/components/organisms/rental-gantt';
import {RentalProgress,RentalDates} from '@/components/organisms/rental-operation';
import {rentalDateTime,rentalWorkflow,rentalSectionHref} from '@/controladores/rental-workflow';

type CalendarView='calendar'|'reservations'|'blocks';
export function CalendarScreen({view='calendar'}:{view?:CalendarView}){const {source}=useBusiness();return source==='supabase'?<Suspense fallback={<p>Cargando flota…</p>}><CalendarWorkspace view={view}/></Suspense>:<CalendarioScreen/>;}
function CalendarWorkspace({view}:{view:CalendarView}){
  const {data,can,refresh,toast}=useBusiness();const [reservations,setReservations]=useState<Reservation[]>([]);
  const search=useSearchParams();
  const [commitments,setCommitments]=useState<Commitment[]>([]);const [evidence,setEvidence]=useState<ReservationEvidence[]>([]);
  const [paymentStatuses,setPaymentStatuses]=useState<Record<string,string>>({});
  const [query,setQuery]=useState('');const [category,setCategory]=useState('Todas');const [create,setCreate]=useState(false);
  const [commercialLine,setCommercialLine]=useState('Todas');
  const [calendarDay,setCalendarDay]=useState(()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'}));
  const readRevision=useRef(0);
  const [openEnded,setOpenEnded]=useState(false);
  const [section,setSection]=useState<CalendarView|'excel'>(()=>search.get('vista')==='calendario'?'calendar':search.get('vista')==='bloqueos'?'blocks':view);
  const [selected,setSelected]=useState<string|null>(null);const [block,setBlock]=useState<Commitment|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  const booking=reservations.find(booking=>booking.id===selected);
  const fleet=data.vehicles.filter(vehicle=>vehicle.inRentalFleet&&(category==='Todas'||vehicle.category===category)&&
    (commercialLine==='Todas'||(vehicle.commercialLine||'Sin línea')===commercialLine));
  const vehicles=fleet.filter(vehicle=>`${vehicle.plate} ${vehicle.brand} ${vehicle.model}`.toLowerCase().includes(query.toLowerCase()))
     .sort((a,b)=>(a.commercialLine||'Sin línea').localeCompare(b.commercialLine||'Sin línea')||a.plate.localeCompare(b.plate));
  const bookingPage=usePagination(reservations.filter(r=>fleet.some(v=>v.id===r.vehicle_id)&&
    `${folio('ALQ',r.folio_number)} ${r.customer_snapshot.name} ${r.vehicle_snapshot.plate} ${r.vehicle_snapshot.model}`.toLowerCase().includes(query.toLowerCase())),query+category+commercialLine);
  const reload=useCallback(async()=>{const revision=++readRevision.current;
    try{
      const [loaded,inspections]=await Promise.all([loadCalendar(),readRows<RentalInspection>('rental_inspections','*')]);
      if(revision!==readRevision.current)return;
      // Actual dates are derived by case RPCs, not stored as reservation columns.
      const dates=new Map(inspections.map(inspection=>[inspection.reservation_id+':'+inspection.kind,inspection.occurred_at]));
      setReservations(loaded.reservations.map(record=>({...record,
        actual_departure_at:dates.get(record.id+':Salida')??null,actual_return_at:dates.get(record.id+':Retorno')??null})));
      setCommitments(loaded.commitments);setEvidence(loaded.evidence);setPaymentStatuses(loaded.paymentStatuses);setError('');
    }catch(error){if(revision===readRevision.current)throw error;}
  },[]);
  useEffect(()=>{let active=true;void reload().catch(error=>{if(active)setError(error.message);});
    return()=>{active=false;readRevision.current++;};},[reload,data]);
  useEffect(()=>{if(search.get('reserva'))setSelected(search.get('reserva'));},[search]);
  async function run(action:()=>Promise<void>){if(sending.current)return;sending.current=true;setBusy(true);setError('');
    try{await action();}catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}}
  async function mutate(command:ReservationCommand,payload:Record<string,unknown>){
    if(!can('orders.write'))throw new Error('No tiene permiso para modificar alquileres.');
    const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    const result=await reservationCommand(command,payload,attempt.current.key);await reload();await refresh();return result;
  }
  function show(id:string){setSelected(id);setError('');}
  return <>
    <PageHeading title="Alquileres" description="Cada alquiler tiene un folio: reserva, entrega, devolución y cuentas."/>
    <div className="module-toolbar"><nav className="module-tabs" aria-label="Vistas de alquileres">{([['reservations','Folios'],['calendar','Calendario'],['blocks','Bloqueos'],...(can('expenses.read')?[['excel','Archivo original']]:[])] as [CalendarView|'excel',string][]).map(([value,label])=>
      <button key={value} className={section===value?'active':''} aria-pressed={section===value} onClick={()=>setSection(value)}>{label}</button>)}</nav>
      <div className="heading-actions">{section==='reservations'?(can('orders.write')?<Button asChild><Link href="/alquileres/nuevo/">Nuevo alquiler</Link></Button>:<Button disabled>Nuevo alquiler</Button>):
        <Button disabled={!can('orders.write')} onClick={()=>{setError('');setCreate(true);}}>Nueva reserva</Button>}</div></div>
    {section==='excel'?<WorkbookPreview format="fleet"/>:<>
    <div className={`${styles.toolbar} module-filter-toolbar`}>
      <label className="form-field"><span>{section==='reservations'?'Buscar folio, cliente o placa':'Buscar placa o modelo'}</span><input value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <label className="form-field"><span>Categoría</span><select aria-label="Categoría" value={category} onChange={event=>setCategory(event.target.value)}>
         <option>Todas</option>{[...new Set(data.vehicles.map(vehicle=>vehicle.category))].map(category=><option key={category}>{category}</option>)}</select></label>
      <label className="form-field"><span>Línea comercial</span><select aria-label="Línea comercial" value={commercialLine} onChange={event=>setCommercialLine(event.target.value)}>
        <option>Todas</option>{[...new Set(data.vehicles.filter(v=>v.inRentalFleet).map(v=>v.commercialLine||'Sin línea'))].sort().map(line=><option key={line}>{line}</option>)}</select></label>
      <Button variant="outline" disabled={busy} onClick={()=>{void run(reload);}}>Actualizar agenda</Button>
    </div>
    {section==='calendar'&&<><RentalMonthCalendar vehicles={vehicles} reservations={reservations} commitments={commitments} onOpen={show} onBlock={setBlock}
      month={calendarDay.slice(0,7)} onMonthChange={month=>setCalendarDay(month+'-01')} onFocusDate={setCalendarDay}/>
      <RentalGantt vehicles={vehicles} reservations={reservations} commitments={commitments} from={calendarDay} onNavigate={setCalendarDay} onOpen={show} onBlock={setBlock}/></>}
    {section==='blocks'&&can('orders.write')&&<details className="panel p-5 mt-5"><summary>Programar bloqueo de taller, limpieza, préstamo o uso interno</summary><form className="operation-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{await mutate('block',{vehicleId:String(f.get('vehicleId')),kind:String(f.get('kind')),
        startsAt:salvadorDateTime(String(f.get('startsAt'))),endsAt:salvadorDateTime(String(f.get('endsAt'))),reason:String(f.get('reason'))});toast('Bloqueo guardado.');});
    }}><label className="form-field"><span>Vehículo a bloquear</span><select aria-label="Vehículo a bloquear" name="vehicleId" required>{data.vehicles.filter(v=>v.inRentalFleet).map(v=><option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
      <label className="form-field"><span>Tipo de bloqueo</span><select aria-label="Tipo de bloqueo" name="kind"><option>Taller</option><option>Limpieza</option><option>Préstamo</option><option>Uso interno</option></select></label>
      <div className="form-grid"><label className="form-field"><span>Inicio del bloqueo</span><input name="startsAt" type="datetime-local" required/></label>
        <label className="form-field"><span>Fin del bloqueo</span><input name="endsAt" type="datetime-local" required/></label></div>
      <label className="form-field"><span>Motivo del bloqueo</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Guardar bloqueo</Button>
    </form></details>}
    {section==='blocks'?<section className="panel p-5 mt-5"><h2 className="font-semibold">Compromisos y conflictos de la flota</h2>
      {commitments.filter(c=>(c.active||/CONFLICTO/i.test(c.reason))&&c.kind!=='Reserva'&&vehicles.some(v=>v.id===c.vehicle_id)).map(c=><article className="inline-note mt-4" key={c.id}>
        <p>{vehicles.find(v=>v.id===c.vehicle_id)?.plate} · {c.kind} · {c.reason}</p><p>Desde {rentalDateTime(c.starts_at)} · Hasta {rentalDateTime(c.ends_at)}</p>
        {c.order_id&&<Link href={orderHref(c.order_id)}>Abrir pliego {c.order_id}</Link>}
        {c.reservation_id&&<Link className="text-link" href={vehicleHref(c.vehicle_id)}>Abrir expediente del vehículo →</Link>}
        <Button variant="outline" onClick={()=>setBlock(c)}>Revisar bloqueo</Button></article>)}
    </section>:section==='reservations'&&<section className={`panel ${styles.records}`} aria-label="Folios de alquiler"><div className={styles.recordsHeading}><div><span>REGISTRO OPERATIVO</span><h2>Folios de alquiler</h2></div><p>{bookingPage.total} {bookingPage.total===1?'folio':'folios'} · Importes previstos, no deuda facturada</p></div><div className="table-scroll"><AdaptiveTable><thead><tr><th>Folio / cliente</th><th>Fechas previstas</th><th>Estado operativo</th><th>Precio previsto</th><th/></tr></thead>
      <tbody>{bookingPage.items.map(r=><tr key={r.id}><td><div className={styles.folioIdentity}><span className={styles.folioMark} aria-hidden>ALQ</span><div><strong className={styles.folioNumber}>{folio('ALQ',r.folio_number)}</strong><strong>{r.customer_snapshot.name}</strong><small>{r.vehicle_snapshot.plate} · {r.vehicle_snapshot.model}</small></div></div></td>
        <td>Entrega: {rentalDateTime(r.starts_at)}<small>Devolución: {r.open_ended?'Sin fecha final definida':rentalDateTime(r.ends_at)}</small></td><td><span className={styles.status} data-tone={rentalWorkflow(r,commitments).tone}>{rentalWorkflow(r,commitments).label}</span></td>
        <td className={styles.amount}>{r.open_ended?'Por período':money(r.total)}<small>{paymentStatuses[r.id]??'Por consultar'}</small></td><td><Button asChild variant="outline"><Link href={rentalHref(r.id)}>Abrir folio</Link></Button>
          </td></tr>)}</tbody></AdaptiveTable></div>{!bookingPage.total&&<p className="module-empty">No hay reservas registradas. Consulte las anotaciones históricas en Archivo original.</p>}<Pagination {...bookingPage}/></section>}
    </>}
    {error&&<p role="alert" className="form-error mt-4">{error}</p>}
    <Dialog open={create} onOpenChange={open=>!busy&&setCreate(open)}><DialogContent className="max-w-2xl"><DialogTitle>Nueva reserva</DialogTitle>
      <DialogDescription>Se guarda un borrador. Confirme después las fechas y la disponibilidad del vehículo.</DialogDescription>
      <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{
        const saved=await mutate('create',{customerId:String(f.get('customerId')),vehicleId:String(f.get('vehicleId')),
          startsAt:salvadorDateTime(String(f.get('startsAt'))),endsAt:openEnded?null:salvadorDateTime(String(f.get('endsAt'))),openEnded,dailyRate:String(f.get('dailyRate')),cleaningMinutes:Number(f.get('cleaningMinutes'))});
        setCreate(false);show(saved.id);
      });}}><label className="form-field"><span>Cliente de reserva</span><select aria-label="Cliente de reserva" name="customerId" required>{data.customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="form-field"><span>Vehículo de reserva</span><select aria-label="Vehículo de reserva" name="vehicleId" required>{data.vehicles.filter(v=>v.inRentalFleet).map(v=><option key={v.id} value={v.id}>{v.plate} · {v.model}</option>)}</select></label>
        <label><input type="checkbox" checked={openEnded} onChange={e=>setOpenEnded(e.target.checked)}/> Alquiler sin fecha final definida (bloquea hasta acordar el fin)</label>
        <div className="form-grid"><label className="form-field"><span>Inicio de reserva</span><input name="startsAt" type="datetime-local" required/></label>
          {!openEnded&&<label className="form-field"><span>Fin de reserva</span><input name="endsAt" type="datetime-local" required/></label>}</div>
        <label className="form-field"><span>Tarifa diaria de reserva (USD)</span><input name="dailyRate" type="number" min="0" step="0.01" required/></label>
        <label className="form-field"><span>Limpieza posterior (minutos)</span><input name="cleaningMinutes" type="number" min="0" max="10080" defaultValue="60" required/></label>
        <Button type="submit" disabled={busy}>Guardar borrador de reserva</Button>
      </form>{error&&<p role="alert" className="form-error">{error}</p>}
    </DialogContent></Dialog>
    <Dialog open={!!booking} onOpenChange={open=>!open&&!busy&&setSelected(null)}><DialogContent className="max-w-3xl">
      <DialogTitle>{booking?.rental_state==='Preparado'?'Reserva':'Alquiler'} de {booking?.customer_snapshot.name}</DialogTitle><DialogDescription>{booking?.vehicle_snapshot.plate} · {folio('ALQ',booking?.folio_number)} · Horario de El Salvador (UTC−6)</DialogDescription>
      {booking&&<><RentalProgress booking={booking} commitments={commitments}/><RentalDates booking={booking}/>
        <div className="rental-actions">
          {booking.status==='Confirmada'&&booking.rental_state==='Entregado'&&<Button asChild><Link href={rentalSectionHref(booking.id,'Salida y devolución')}>Registrar devolución</Link></Button>}
          {booking.status==='Confirmada'&&booking.rental_state==='Preparado'&&<Button asChild><Link href={rentalSectionHref(booking.id,'Salida y devolución')}>Preparar entrega</Link></Button>}
          {['Devuelto','Cerrado'].includes(booking.rental_state)&&<Button asChild><Link href={vehicleHref(booking.vehicle_id)}>Liberar vehículo</Link></Button>}
         <Button variant="outline" asChild><Link href={rentalHref(booking.id)}>Abrir folio</Link></Button>
         {can('expenses.read')&&<Button variant="outline" asChild><Link href={rentalSectionHref(booking.id,'Cargos y abonos')}>Ver cobros</Link></Button>}
          <Button variant="outline" asChild><Link href={vehicleHref(booking.vehicle_id)}>Abrir expediente del vehículo</Link></Button>
        </div>
        <p className="field-hint mt-4">Precio previsto: {booking.open_ended?'Sin total final acordado':money(booking.total)}. No equivale a un cargo ni a un pago.</p>
         <p className="inline-note mt-4">Esta vista es de consulta. Abra el folio para confirmar acuerdos, modificar fechas o registrar operaciones y dinero por separado.</p>
        {evidence.filter(note=>note.reservation_id===booking.id).map(note=><article className="inline-note mt-4" key={note.id}><p>{note.body}</p><small>{rentalDateTime(note.created_at)}</small></article>)}
      </>}{error&&<p role="alert" className="form-error mt-4">{error}</p>}
    </DialogContent></Dialog>
    <Dialog open={!!block} onOpenChange={open=>!open&&!busy&&setBlock(null)}><DialogContent><DialogTitle>Bloqueo de {block?.kind}</DialogTitle><DialogDescription>{block?.reason}</DialogDescription>
      {block?.reservation_id&&<p className="inline-note mt-4">La liberación de un alquiler se confirma en el expediente del vehículo. <Link className="text-link" href={vehicleHref(block.vehicle_id)}>Abrir expediente →</Link></p>}
      {block&&!block.reservation_id&&block.active&&can('orders.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{
        await mutate(block.order_id?'plan_workshop':'finish_block',block.order_id?{orderId:block.order_id,endsAt:salvadorDateTime(String(f.get('endsAt'))),reason:String(f.get('reason'))}:{blockId:block.id,reason:String(f.get('reason'))});setBlock(null);
      });}}>{block.order_id&&<label className="form-field"><span>Fin previsto del taller</span><input name="endsAt" type="datetime-local" required/></label>}
        <label className="form-field"><span>Motivo de actualización del bloqueo</span><input name="reason" required/></label>
        <Button type="submit" disabled={busy}>{block.order_id?'Programar fin de taller':'Finalizar bloqueo y revisar disponibilidad'}</Button></form>}
      {error&&<p role="alert" className="form-error">{error}</p>}
    </DialogContent></Dialog>
  </>;
}
