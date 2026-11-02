'use client';
import {Suspense,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {CalendarioScreen} from './calendario-screen';
import {loadCalendar,reservationCommand,rentalAlternatives,salvadorDateTime,type Reservation,type Commitment,type ReservationEvidence,type ReservationCommand} from '@/lib/supabase/reservations';
import {money} from '@/controladores/finanzas';
import styles from './operational-calendar.module.css';
import {RentalInspectionReview} from '@/components/organisms/rental-inspection';
import {RentalContracts} from '@/components/organisms/rental-contracts';
import {WorkbookPreview} from '@/components/organisms/workbook-preview';
import {RentalPeriods} from '@/components/organisms/rental-periods';
import {vehicleHref,orderHref,rentalHref} from '@/lib/supabase/cases';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {Pagination,usePagination} from '@/components/organisms/pagination';
import {folio} from '@/controladores/folios';
import {RentalMonthCalendar} from '@/components/organisms/rental-month-calendar';

type CalendarView='calendar'|'reservations'|'blocks';
export function CalendarScreen({view='calendar'}:{view?:CalendarView}){const {source}=useBusiness();return source==='supabase'?<Suspense fallback={<p>Cargando flota…</p>}><CalendarWorkspace view={view}/></Suspense>:<CalendarioScreen/>;}
function CalendarWorkspace({view}:{view:CalendarView}){
  const {data,can,refresh,toast,open}=useBusiness();const [reservations,setReservations]=useState<Reservation[]>([]);
  const search=useSearchParams();
  const [commitments,setCommitments]=useState<Commitment[]>([]);const [evidence,setEvidence]=useState<ReservationEvidence[]>([]);
  const [paymentStatuses,setPaymentStatuses]=useState<Record<string,string>>({});
  const [query,setQuery]=useState('');const [category,setCategory]=useState('Todas');const [create,setCreate]=useState(false);
  const [commercialLine,setCommercialLine]=useState('Todas');
  const [openEnded,setOpenEnded]=useState(false);
  const [section,setSection]=useState<CalendarView|'excel'>(view);
  const [selected,setSelected]=useState<string|null>(null);const [block,setBlock]=useState<Commitment|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [alternatives,setAlternatives]=useState<{id:string;plate:string}[]>([]);
  const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  const booking=reservations.find(booking=>booking.id===selected);
  const vehicles=data.vehicles.filter(vehicle=>vehicle.inRentalFleet&&(category==='Todas'||vehicle.category===category)&&
    (commercialLine==='Todas'||(vehicle.commercialLine||'Sin línea')===commercialLine)&&
    `${vehicle.plate} ${vehicle.brand} ${vehicle.model}`.toLowerCase().includes(query.toLowerCase()))
     .sort((a,b)=>(a.commercialLine||'Sin línea').localeCompare(b.commercialLine||'Sin línea')||a.plate.localeCompare(b.plate));
  const bookingPage=usePagination(reservations.filter(r=>vehicles.some(v=>v.id===r.vehicle_id)),query+category+commercialLine);
  async function reload(){const loaded=await loadCalendar();setReservations(loaded.reservations);setCommitments(loaded.commitments);setEvidence(loaded.evidence);setPaymentStatuses(loaded.paymentStatuses);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[]);
  useEffect(()=>{if(search.get('reserva'))setSelected(search.get('reserva'));},[search]);
  async function run(action:()=>Promise<void>){if(sending.current)return;sending.current=true;setBusy(true);setError('');
    try{await action();}catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}}
  async function mutate(command:ReservationCommand,payload:Record<string,unknown>){
    const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    const result=await reservationCommand(command,payload,attempt.current.key);await reload();await refresh();return result;
  }
  function show(id:string){setSelected(id);setError('');setAlternatives([]);}
  return <>
    <PageHeading title="Calendario" description="Reservas y disponibilidad de tus vehículos."
      actions={<Button disabled={!can('orders.write')} onClick={()=>{setError('');setCreate(true);}}>Nueva reserva</Button>}/>
    <nav className="module-tabs" aria-label="Vistas del calendario">{([['calendar','Calendario'],['reservations','Reservas'],['blocks','Bloqueos'],...(can('expenses.read')?[['excel','Archivo original']]:[])] as [CalendarView|'excel',string][]).map(([value,label])=>
      <button key={value} className={section===value?'active':''} aria-pressed={section===value} onClick={()=>setSection(value)}>{label}</button>)}</nav>
    {section==='excel'?<WorkbookPreview format="fleet"/>:<>
    <div className={styles.toolbar}>
      <label className="form-field"><span>Buscar placa o modelo</span><input value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <label className="form-field"><span>Categoría</span><select aria-label="Categoría" value={category} onChange={event=>setCategory(event.target.value)}>
         <option>Todas</option>{[...new Set(data.vehicles.map(vehicle=>vehicle.category))].map(category=><option key={category}>{category}</option>)}</select></label>
      <label className="form-field"><span>Línea comercial</span><select aria-label="Línea comercial" value={commercialLine} onChange={event=>setCommercialLine(event.target.value)}>
        <option>Todas</option>{[...new Set(data.vehicles.filter(v=>v.inRentalFleet).map(v=>v.commercialLine||'Sin línea'))].sort().map(line=><option key={line}>{line}</option>)}</select></label>
      <Button variant="outline" disabled={busy} onClick={()=>{void run(reload);}}>Actualizar agenda</Button>
    </div>
    {section==='calendar'&&<RentalMonthCalendar vehicles={vehicles} reservations={reservations} commitments={commitments} onOpen={show} onBlock={setBlock}/>}
    {section==='blocks'&&<details className="panel p-5 mt-5"><summary>Programar bloqueo de taller, limpieza, préstamo o uso interno</summary><form className="operation-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{await mutate('block',{vehicleId:String(f.get('vehicleId')),kind:String(f.get('kind')),
        startsAt:salvadorDateTime(String(f.get('startsAt'))),endsAt:salvadorDateTime(String(f.get('endsAt'))),reason:String(f.get('reason'))});toast('Bloqueo guardado.');});
    }}><label className="form-field"><span>Vehículo a bloquear</span><select aria-label="Vehículo a bloquear" name="vehicleId" required>{data.vehicles.filter(v=>v.inRentalFleet).map(v=><option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
      <label className="form-field"><span>Tipo de bloqueo</span><select aria-label="Tipo de bloqueo" name="kind"><option>Taller</option><option>Limpieza</option><option>Préstamo</option><option>Uso interno</option></select></label>
      <div className="form-grid"><label className="form-field"><span>Inicio del bloqueo</span><input name="startsAt" type="datetime-local" required/></label>
        <label className="form-field"><span>Fin del bloqueo</span><input name="endsAt" type="datetime-local" required/></label></div>
      <label className="form-field"><span>Motivo del bloqueo</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Guardar bloqueo</Button>
    </form></details>}
    {section==='blocks'?<section className="panel p-5 mt-5"><h2 className="font-semibold">Bloqueos activos de la flota</h2>
      {commitments.filter(c=>c.active&&c.kind!=='Reserva'&&vehicles.some(v=>v.id===c.vehicle_id)).map(c=><article className="inline-note mt-4" key={c.id}>
        <p>{vehicles.find(v=>v.id===c.vehicle_id)?.plate} · {c.kind} · {c.reason}</p><p>{c.starts_at} → {c.ends_at==='infinity'?'Sin fin previsto':c.ends_at}</p>
        {c.order_id&&<Link href={orderHref(c.order_id)}>Abrir pliego {c.order_id}</Link>}
        <Button variant="outline" onClick={()=>setBlock(c)}>Revisar bloqueo</Button></article>)}
    </section>:section==='reservations'&&<section className={`panel ${styles.records}`}><div className="table-scroll"><AdaptiveTable><thead><tr><th>Reserva / cliente</th><th>Fechas</th><th>Estado</th><th>Precio previsto</th><th/></tr></thead>
      <tbody>{bookingPage.items.map(r=><tr key={r.id}><td><strong>{folio('ALQ',r.folio_number)}</strong><strong>{r.customer_snapshot.name}</strong><small>{r.vehicle_snapshot.plate}</small></td>
        <td>{new Date(r.starts_at).toLocaleString('es-SV')}<small>{r.open_ended?'Sin fecha final definida':new Date(r.ends_at).toLocaleString('es-SV')}</small></td><td>{r.status} · {r.rental_state}</td>
        <td className={styles.amount}>{r.open_ended?'Por período':money(r.total)}<small>{paymentStatuses[r.id]??'Por consultar'}</small></td><td><Button asChild variant="outline"><Link href={rentalHref(r.id)}>Abrir pliego de alquiler</Link></Button>
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
      <DialogTitle>Reserva de {booking?.customer_snapshot.name}</DialogTitle><DialogDescription>Estado, acuerdos y cambios auditados; pago y disponibilidad son estados separados.</DialogDescription>
      {booking&&<><p className="inline-note mt-4">{booking.vehicle_snapshot.plate} · {booking.status} · {booking.rental_state} · V{booking.version} · {booking.open_ended?'Sin total final acordado':money(booking.total)}</p>
        <Button variant="outline" asChild><Link href={vehicleHref(booking.vehicle_id)}>Abrir expediente del vehículo</Link></Button>
        {can('expenses.write')&&<Button variant="outline" onClick={()=>open('gasto',`reservation:${booking.id}`)}>Registrar gasto de alquiler</Button>}
        {booking.status==='Borrador'&&<Button disabled={busy} onClick={()=>{void run(async()=>{await mutate('confirm',{reservationId:booking.id,expectedVersion:booking.version});});}}>Confirmar reserva</Button>}
        {booking.status==='Confirmada'&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{
          const endsAt=salvadorDateTime(String(f.get('endsAt')));setAlternatives([]);
          try{await mutate(booking.open_ended?'set_end':'extend',{reservationId:booking.id,expectedVersion:booking.version,endsAt,reason:String(f.get('reason'))});}
          catch(error){setAlternatives(await rentalAlternatives(booking.starts_at,new Date(Date.parse(endsAt)+booking.cleaning_minutes*60000).toISOString(),booking.id));throw error;}
        });}}><label className="form-field"><span>Nueva fecha final</span><input name="endsAt" type="datetime-local" required/></label>
          <label className="form-field"><span>Motivo de extensión</span><input name="reason" required/></label><Button type="submit" variant="outline" disabled={busy}>{booking.open_ended?'Acordar fecha final':'Solicitar extensión'}</Button>
        </form>}
        {!!alternatives.length&&<p className="inline-note">Alternativas disponibles: {alternatives.map(car=>car.plate).join(', ')}</p>}
        {booking.status!=='Cancelada'&&booking.rental_state==='Preparado'&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
          void run(async()=>{await mutate('cancel',{reservationId:booking.id,expectedVersion:booking.version,reason:String(f.get('reason'))});});
        }}><label className="form-field"><span>Motivo de cancelación</span><input name="reason" required/></label><Button variant="outline" type="submit" disabled={busy}>Cancelar reserva con motivo</Button></form>}
        <form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);void run(async()=>{
          await mutate('evidence',{reservationId:booking.id,body:String(f.get('body'))});form.reset();
        });}}><label className="form-field"><span>Acuerdo o texto de WhatsApp</span><textarea name="body" required maxLength={20000}/></label><Button type="submit" variant="outline" disabled={busy}>Guardar evidencia de WhatsApp</Button></form>
        {evidence.filter(note=>note.reservation_id===booking.id).map(note=><article className="inline-note mt-4" key={note.id}><p>{note.body}</p><small>{note.created_by} · {new Date(note.created_at).toLocaleString('es-SV')}</small></article>)}
        <RentalInspectionReview key={booking.id} booking={booking} onChange={async()=>{await reload();await refresh();}}/>
        <RentalContracts booking={booking}/>
        <RentalPeriods booking={booking}/>
      </>}{error&&<p role="alert" className="form-error mt-4">{error}</p>}
    </DialogContent></Dialog>
    <Dialog open={!!block} onOpenChange={open=>!open&&!busy&&setBlock(null)}><DialogContent><DialogTitle>Bloqueo de {block?.kind}</DialogTitle><DialogDescription>{block?.reason}</DialogDescription>
      {block&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{
        await mutate(block.order_id?'plan_workshop':'finish_block',block.order_id?{orderId:block.order_id,endsAt:salvadorDateTime(String(f.get('endsAt'))),reason:String(f.get('reason'))}:{blockId:block.id,reason:String(f.get('reason'))});setBlock(null);
      });}}>{block.order_id&&<label className="form-field"><span>Fin previsto del taller</span><input name="endsAt" type="datetime-local" required/></label>}
        <label className="form-field"><span>Motivo de actualización del bloqueo</span><input name="reason" required/></label>
        <Button type="submit" disabled={busy}>{block.order_id?'Programar fin de taller':'Finalizar bloqueo y revisar disponibilidad'}</Button></form>}
      {error&&<p role="alert" className="form-error">{error}</p>}
    </DialogContent></Dialog>
  </>;
}
