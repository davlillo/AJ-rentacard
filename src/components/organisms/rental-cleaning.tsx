'use client';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {reservationCommand} from '@/lib/supabase/reservations';
import type {CaseFile} from '@/lib/supabase/cases';
import {vehicleHref} from '@/lib/supabase/cases';
import {rentalDateTime} from '@/controladores/rental-workflow';

export function RentalCleaning({file,onChange}:{file:CaseFile;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);const booking=file.reservations[0];
  const cleaning=file.commitments.filter(c=>c.reservation_id===booking.id&&c.kind==='Limpieza');
  const returned=['Devuelto','Cerrado'].includes(booking.rental_state)&&booking.status!=='Cancelada';
  const reviewed=returned&&cleaning.length>0&&!cleaning.some(c=>c.active);
  return <section className="panel p-5"><h2 className="font-semibold">Limpieza y liberación del vehículo</h2>
    <p className="field-hint mt-3">Finalice la limpieza solo después de revisar el vehículo devuelto. Esto no cobra ni elimina deuda.</p>
    {!reviewed&&<p className="mt-3">Estado físico actual de la unidad: <strong>{file.vehicle.status}</strong>.</p>}
    {reviewed&&<p className="mt-3">La limpieza de este alquiler ya fue revisada. <Link className="text-link" href={vehicleHref(file.vehicle.id)}>Ver disponibilidad actual del vehículo →</Link></p>}
    {!returned&&<p className="inline-note mt-4">Primero debe registrar la devolución del alquiler. La limpieza prevista no confirma que el vehículo ya regresó.</p>}
    {cleaning.map(block=><article className="inline-note mt-4" key={block.id}><h3 className="font-semibold">{returned?(block.active?'Limpieza pendiente':'Limpieza revisada'):(block.active?'Limpieza prevista':'Limpieza inactiva')}</h3>
      <p>{block.reason}</p><p>Inicio: {rentalDateTime(block.starts_at)} · Fin: {rentalDateTime(block.ends_at)}</p>
      {returned&&block.active&&can('orders.write')&&<form className="operation-form" onSubmit={event=>{
        event.preventDefault();const f=new FormData(event.currentTarget);const payload={blockId:block.id,reason:String(f.get('reason'))};
        void execute('reservation.finish_block',payload,key=>reservationCommand('finish_block',payload,key));
      }}><label className="form-field"><span>Revisión de limpieza y condición para otra renta</span><textarea name="reason" required disabled={busy}/></label>
        <Button type="submit" disabled={busy}>Confirmar limpieza y revisar disponibilidad</Button></form>}
    </article>)}
    {!cleaning.length&&<p className="inline-note mt-4">{returned?'No se encontró una limpieza de este alquiler. Revise los bloqueos antes de liberar el vehículo.':'La revisión posterior se registra al devolver el vehículo.'}</p>}
    <p className="mt-4"><Link className="text-link" href="/vehiculos/bloqueos/">Consultar otros bloqueos de la flota →</Link></p>
    {error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </section>;
}
