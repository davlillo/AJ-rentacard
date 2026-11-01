'use client';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useCallback,useEffect,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {RentalInspectionReview} from '@/components/organisms/rental-inspection';
import {RentalContracts} from '@/components/organisms/rental-contracts';
import {RentalPeriods} from '@/components/organisms/rental-periods';
import {CasePayments} from '@/components/organisms/case-payments';
import {CaseFiles} from './vehicle-case-screen';
import {loadRentalCase,vehicleHref,type CaseFile} from '@/lib/supabase/cases';
import {reservationCommand,salvadorDateTime,type ReservationCommand} from '@/lib/supabase/reservations';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';

export function RentalCaseScreen(){const id=useSearchParams().get('id')??'';return <RentalContent key={id} id={id}/>;}
function RentalContent({id}:{id:string}){
  const {can,refresh,open,modal}=useBusiness();const [file,setFile]=useState<CaseFile|null>(null);
  const [loadError,setLoadError]=useState('');const [tab,setTab]=useState('Resumen');
  const reload=useCallback(async()=>{const result=await loadRentalCase(id);setFile(result);setLoadError('');await refresh();},[id,refresh]);
  const {busy,error,execute}=useCaseAction(reload);
  useEffect(()=>{let active=true;if(id)void loadRentalCase(id).then(result=>{if(active){setFile(result);setLoadError('');}})
    .catch(error=>{if(active)setLoadError(error.message);});return()=>{active=false;};},[id,modal.kind]);
  function mutate(command:ReservationCommand,payload:Record<string,unknown>){return execute(`reservation.${command}`,payload,key=>reservationCommand(command,payload,key));}
  if(!id)return <p role="alert" className="form-error">Falta el identificador del alquiler.</p>;
  if(!file)return <p role={loadError?'alert':'status'}>{loadError||'Cargando pliego del alquiler…'}</p>;
  const booking=file.reservations[0];const car=file.vehicle;
  return <><nav aria-label="Ubicación del alquiler" className="mb-5"><Link href="/vehiculos">Flota</Link> / <Link href={vehicleHref(car.id)}>{car.plate}</Link> / Alquiler</nav>
    <PageHeading eyebrow="PLIEGO DEL ALQUILER / OPERACIÓN INDEPENDIENTE" title={`${folio('ALQ',booking.folio_number)} · ${car.plate}`}
      description={`${booking.status} · ${booking.rental_state} · ${booking.starts_at} → ${booking.open_ended?'Sin fecha final definida':booking.ends_at}`}
      actions={<Button variant="outline" disabled={busy} onClick={()=>{void reload().catch(error=>setLoadError(error.message));}}>Actualizar alquiler</Button>}/>
    <nav className="tabs mb-5 flex-wrap" aria-label="Secciones del alquiler">
      {['Resumen','Salida y devolución','Períodos y abonos','Gastos','Fotos y documentos','Contrato'].filter(t=>!['Períodos y abonos','Gastos'].includes(t)||file.financialAccess).map(t=>
        <button key={t} className={tab===t?'active':''} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t}</button>)}
    </nav>
    {tab==='Resumen'&&<section className="panel p-5"><h2 className="font-semibold">Acuerdo y estado del alquiler</h2>
      <dl className="detail-list mt-4"><div><dt>Estado físico del vehículo</dt><dd>{car.status}</dd></div>
        <div><dt>Estado de la operación</dt><dd>{booking.status} · {booking.rental_state}</dd></div>
        <div><dt>Tarifa diaria acordada</dt><dd>{money(booking.daily_rate)}</dd></div>
        <div><dt>Precio final previsto</dt><dd>{booking.open_ended?'Sin total final acordado; documentar por períodos':money(booking.total)}</dd></div></dl>
      <p className="inline-note mt-4">Pagar un período no libera el carro ni cancela la reserva. El alquiler sin fin acordado mantiene ocupación abierta.</p>
      {booking.status==='Borrador'&&<Button className="mt-4" disabled={busy||!can('orders.write')} onClick={()=>{void mutate('confirm',{reservationId:id,expectedVersion:booking.version});}}>Confirmar reserva del pliego</Button>}
      {booking.status==='Confirmada'&&['Preparado','Entregado'].includes(booking.rental_state)&&can('orders.write')&&<form className="operation-form" onSubmit={event=>{
        event.preventDefault();const f=new FormData(event.currentTarget);void mutate(booking.open_ended?'set_end':'extend',{
          reservationId:id,expectedVersion:booking.version,endsAt:salvadorDateTime(String(f.get('endsAt'))),reason:String(f.get('reason'))});
      }}><label className="form-field"><span>{booking.open_ended?'Fecha final ahora acordada':'Nueva fecha final de extensión'}</span><input name="endsAt" type="datetime-local" required/></label>
        <label className="form-field"><span>Evidencia del cambio de fecha</span><textarea name="reason" required/></label>
        <Button type="submit" disabled={busy}>{booking.open_ended?'Acordar fin del alquiler abierto':'Extender sin solapar compromisos'}</Button></form>}
      {booking.status!=='Cancelada'&&booking.rental_state==='Preparado'&&can('orders.write')&&<details className="mt-5"><summary>Cancelar reserva no entregada</summary>
        <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
          void mutate('cancel',{reservationId:id,expectedVersion:booking.version,reason:String(f.get('reason'))});
        }}><label className="form-field"><span>Motivo de cancelación operativa</span><input name="reason" required/></label>
          <Button type="submit" variant="outline" disabled={busy}>Cancelar sin borrar deuda ni recibos</Button></form></details>}
    </section>}
    {tab==='Salida y devolución'&&<section className="panel p-5"><RentalInspectionReview booking={booking} onChange={reload}/>
      <p className="inline-note mt-4"><Link href="/vehiculos/bloqueos">La devolución mantiene revisión de limpieza. Consultar bloqueos para liberar disponibilidad.</Link></p></section>}
    {tab==='Períodos y abonos'&&file.financialAccess&&<section className="panel p-5"><RentalPeriods key={file.applications?.length} booking={booking}/>
      <CasePayments file={file} reservationId={id} onChange={reload}/></section>}
    {tab==='Gastos'&&file.financialAccess&&<section className="panel p-5"><h2 className="font-semibold">Gastos de este alquiler</h2>
      {(file.expenses??[]).map(e=><p className="inline-note mt-4" key={e.id}>{e.date} · {e.id} · {e.concept} · {money(e.amount)}</p>)}
      {!file.expenses?.length&&<p className="mt-4">No hay gastos asignados a este alquiler.</p>}
      {can('expenses.write')&&<Button className="mt-4" onClick={()=>open('gasto',`reservation:${id}`)}>Registrar gasto en este alquiler</Button>}</section>}
    {tab==='Fotos y documentos'&&<CaseFiles file={file} reservationId={id} onChange={reload}/>}
    {tab==='Contrato'&&<section className="panel p-5"><RentalContracts booking={booking}/></section>}
    {(error||loadError)&&<p role="alert" className="form-error mt-4">{error||loadError}</p>}
  </>;
}
