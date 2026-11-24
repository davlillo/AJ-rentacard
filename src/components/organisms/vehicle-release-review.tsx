'use client';
import Link from 'next/link';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {rentalRpc,type Reservation,type Commitment} from '@/lib/supabase/reservations';
import type {CaseFile} from '@/lib/supabase/cases';
import {vehicleHref} from '@/lib/supabase/cases';
import {folio} from '@/controladores/folios';
import {rentalDateTime,rentalCleaningStatus,rentalCleaningReviewable} from '@/controladores/rental-workflow';
import styles from './rental-inspection.module.css';

// The release of a vehicle lives on the vehicle side: the fleet is not stranded, but the rental
// folio does not carry the confirmation. The command, the payload, the optimistic versions, the
// idempotency key and the permission check are exactly the canonical ones.
interface ReleaseResult {
  reservation:Reservation;vehicle:{status:string;version:number;readiness_hold:boolean};cleaning:Commitment;
  cleaningReviewed:boolean;releaseBlocked:boolean;
}
interface ReleaseConfirmation {
  command:'review_return_cleaning';payload:Record<string,unknown>;folio:string;customer:string;vehicle:string;
}

export function VehicleReleaseReview({file,booking,onChange}:{file:CaseFile;booking:Reservation;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const [confirmation,setConfirmation]=useState<ReleaseConfirmation|null>(null);const [notice,setNotice]=useState('');
  const [reason,setReason]=useState('');
  const {cleaning,returned,reviewed,conflict}=rentalCleaningStatus(booking,file.commitments);
  async function confirm(){
    if(!confirmation)return;
    const intent=confirmation;
    const saved=await execute('reservation.'+intent.command,intent.payload,async key=>{
      const result=await rentalRpc<ReleaseResult>('execute_reservation_command',{
        command:intent.command,payload:intent.payload,idempotency_key:key});
      if(result.cleaningReviewed){
        setNotice(result.releaseBlocked?'Entrega confirmada. El vehículo sigue retenido por otros compromisos o trabajos; no está liberado.':
          'Entrega confirmada. El servidor confirmó la liberación del vehículo.');
        setConfirmation(null);setReason('');
      }
      return result;
    });
    if(saved)setConfirmation(null);
  }
  return <section className="panel p-5" aria-label="Liberación del vehículo">
    <h2 className="font-semibold">Liberar el vehículo</h2>
    <p className="field-hint mt-3">Confirme la entrega del vehículo para que vuelva a estar disponible.
      Si existen otros compromisos, reservas o trabajos, el vehículo sigue retenido.
      Esta confirmación no cobra nada, no emite importes y no cancela deuda.</p>
    <p className="mt-3">Estado físico actual de la unidad: <strong>{file.vehicle.status}</strong>.</p>
    {notice&&<p className="inline-note mt-4" role="status">{notice}</p>}
    {reviewed&&<p className="mt-3">La entrega de este alquiler ya fue confirmada. <Link className="text-link" href={vehicleHref(file.vehicle.id)}>Ver disponibilidad actual del vehículo →</Link></p>}
    {!returned&&<p className="inline-note mt-4">Primero debe registrar la devolución del alquiler en su folio. La entrega no se confirma antes de devolver el vehículo.</p>}
    {conflict&&<p className="form-error mt-4" role="alert">Hay un compromiso en conflicto sin resolver. El vehículo sigue retenido. Un bloqueo inactivo no confirma la entrega ni libera el alquiler.</p>}
    {returned&&!reviewed&&!cleaning.some(block=>rentalCleaningReviewable(booking,block))&&<p className="inline-note mt-4">No se encontró un compromiso de esta devolución habilitado para confirmar la entrega.
      Actualice y revise el expediente. Un bloqueo general o un compromiso histórico no reemplazan esta confirmación.</p>}
    {cleaning.map(block=><article className="inline-note mt-4" key={block.id}><h3 className="font-semibold">{returned?(reviewed?'Entrega confirmada':block.active?'Entrega pendiente':'Entrega sin confirmar'):(block.active?'Entrega prevista':'Entrega inactiva')}</h3>
      <p>{block.reason}</p><p>Inicio: {rentalDateTime(block.starts_at)} · Fin: {rentalDateTime(block.ends_at)}</p>
      {!notice&&!confirmation&&!reviewed&&rentalCleaningReviewable(booking,block)&&can('orders.write')&&<form className="operation-form" onSubmit={event=>{
        event.preventDefault();const f=new FormData(event.currentTarget);
        setConfirmation(Object.freeze({command:'review_return_cleaning',payload:Object.freeze({
          reservationId:booking.id,blockId:block.id,expectedVersion:booking.version,expectedVehicleVersion:file.vehicle.version,
          reason:String(f.get('reason')).trim(),
        }),folio:folio('ALQ',booking.folio_number),customer:booking.customer_snapshot.name,vehicle:file.vehicle.plate}));
      }}><label className="form-field"><span>Descripción de la entrega y la condición del vehículo</span>
        <textarea name="reason" aria-label="Descripción de la entrega y la condición del vehículo" required maxLength={4000} disabled={busy}
          value={reason} onChange={event=>{setReason(event.target.value);event.target.setCustomValidity(
            event.target.value.trim()?'':'Indique la entrega realizada.');}}/></label>
        <Button type="submit" disabled={busy||!Number.isInteger(file.vehicle.version)}>Confirmar entrega y liberar el vehículo</Button></form>}
    </article>)}
    {confirmation&&<section className={styles.confirmation} aria-label="Confirmación de liberación">
      <h3>Confirmar la entrega y la liberación del vehículo</h3>
      <p>{confirmation.folio} · {confirmation.customer} · {confirmation.vehicle}</p>
      <p>{String(confirmation.payload.reason)}</p>
      <p>El vehículo vuelve a estar disponible. No se activa un intervalo superpuesto ni se registra un cobro.
        Otros compromisos, reservas o trabajos pueden mantener el vehículo retenido.</p>
      {(booking.version!==confirmation.payload.expectedVersion||file.vehicle.version!==confirmation.payload.expectedVehicleVersion)&&
        <p className="inline-note" role="status">El folio o el vehículo cambió. Se conserva la versión confirmada; revise antes de reintentar.</p>}
      <div className={styles.actions}>
        <Button type="button" disabled={busy||!can('orders.write')} onClick={()=>void confirm()}>Confirmar la liberación del vehículo</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={()=>setConfirmation(null)}>Volver a revisar la entrega</Button>
      </div>
    </section>}
    {!cleaning.length&&<p className="inline-note mt-4">{returned?'No se encontró un compromiso de este alquiler. Revise los bloqueos antes de liberar el vehículo.':'La entrega se registra al devolver el vehículo.'}</p>}
    <p className="mt-4"><Link className="text-link" href="/alquileres/?vista=bloqueos">Consultar compromisos de la flota →</Link></p>
    {error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </section>;
}
