'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {loadRentalInspections,rentalRpc,type RentalInspection,type RentalExtra,type Reservation} from '@/lib/supabase/reservations';
import {money} from '@/controladores/finanzas';
import {AdaptiveTable} from './adaptive-table';

export function RentalInspectionReview({booking,onChange}:{booking:Reservation;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const [inspections,setInspections]=useState<RentalInspection[]>([]);const [extras,setExtras]=useState<RentalExtra[]>([]);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function reload(){const result=await loadRentalInspections(booking.id);setInspections(result.inspections);setExtras(result.extras);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[booking.id]);
  async function submit(command:string,payload:Record<string,unknown>){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    try{await rentalRpc('execute_rental_command',{command,payload,idempotency_key:attempt.current.key});await reload();await onChange();}
    catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  return <section className="mt-6"><h3 className="font-semibold">Inspección de salida y devolución</h3>
    <p className="field-hint">Una diferencia genera una propuesta, no un cargo ni un cobro automático. La devolución mantiene el vehículo bloqueado hasta revisar limpieza.</p>
    <div className="table-scroll mt-3"><AdaptiveTable><thead><tr><th>Inspección</th><th>KM / combustible</th><th>Condición / accesorios</th></tr></thead>
      <tbody>{inspections.map(inspection=><tr key={inspection.id}><td>{inspection.kind}<small>{inspection.occurred_at}</small></td>
        <td>{inspection.km} km · {inspection.fuel}%</td><td>{inspection.condition}<small>{inspection.accessories}</small><small>{inspection.evidence}</small></td></tr>)}</tbody></AdaptiveTable></div>
    {booking.status==='Confirmada'&&['Preparado','Entregado'].includes(booking.rental_state)&&<form className="operation-form" onSubmit={event=>{
      event.preventDefault();const f=new FormData(event.currentTarget);void submit(booking.rental_state==='Preparado'?'depart':'return',{
        reservationId:booking.id,expectedVersion:booking.version,...Object.fromEntries(['km','fuel','condition','accessories','evidence'].map(key=>[key,String(f.get(key))]))});
    }}><div className="form-grid"><label className="form-field"><span>Kilometraje de inspección</span><input name="km" type="number" min="0" required/></label>
      <label className="form-field"><span>Combustible de inspección (%)</span><input name="fuel" type="number" min="0" max="100" step="0.01" required/></label></div>
      <label className="form-field"><span>Condición observada</span><textarea name="condition" required/></label>
      <label className="form-field"><span>Accesorios observados</span><input name="accessories" required/></label>
      <label className="form-field"><span>Evidencia de inspección</span><textarea name="evidence" required/></label>
      <Button type="submit" disabled={busy}>{booking.rental_state==='Preparado'?'Registrar salida de alquiler':'Registrar devolución de alquiler'}</Button>
    </form>}
    {extras.map(extra=><article key={extra.id} className="inline-note mt-4"><strong>{extra.description} · {extra.status}</strong>
      <p>{extra.amount===null?'Importe por revisar':money(extra.amount)} · {extra.reason}</p>
      {extra.status==='Propuesto'&&can('expenses.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
        void submit('decide_extra',{proposalId:extra.id,expectedVersion:extra.version,decision:String(f.get('decision')),amount:f.get('amount')||null,reason:String(f.get('reason'))});
      }}><label className="form-field"><span>Decisión del extra</span><select aria-label="Decisión del extra" name="decision"><option>Aprobado</option><option>Rechazado</option></select></label>
        <label className="form-field"><span>Importe propuesto del extra (USD)</span><input name="amount" type="number" min="0.01" step="0.01"/></label>
        <label className="form-field"><span>Motivo y autorización del extra</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Guardar decisión del extra</Button>
      </form>}
    </article>)}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </section>;
}
