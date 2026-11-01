'use client';
import {useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {deliveryChecklist,deliverOrder,loadDelivery,type DeliveryChecklist,type WorkshopDelivery} from '@/lib/supabase/workshop';

export function WorkshopDeliveryReview({orderId,onChange}:{orderId:string;onChange?:()=>Promise<void>}){
  const {refresh}=useBusiness();const [checklist,setChecklist]=useState<DeliveryChecklist|null>(null);
  const [delivery,setDelivery]=useState<WorkshopDelivery>();const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function reload(){const [checklist,delivery]=await Promise.all([deliveryChecklist(orderId),loadDelivery(orderId)]);setChecklist(checklist);setDelivery(delivery);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[orderId]);
  return <section>
    <p className="inline-note">El servidor vuelve a revisar costos, tareas, cronómetros y alcance al confirmar. La entrega no borra deuda
      ni convierte un vehículo de flota en disponible. Inspección, fotos y documentos se consultan en las secciones del pliego.</p>
    <Button variant="outline" className="mt-4" disabled={busy} onClick={()=>{void reload().catch(error=>setError(error.message));}}>Actualizar revisión</Button>
    {checklist&&<><ul className="mt-4 space-y-2" aria-label="Pendientes de entrega">
      <li>Costos sin disposición: <strong>{checklist.pendingCosts}</strong></li>
      <li>Tareas sin finalizar: <strong>{checklist.openTasks.length}</strong></li>
      <li>Cronómetros abiertos: <strong>{checklist.openTimers.length}</strong></li>
      <li>Versión pendiente de decisión: {checklist.pendingEstimate??'Ninguna'}</li>
      <li>Saldo documental: {money(checklist.estimatedUnpaid)}. Los cargos pendientes de emitir siguen señalados por separado.</li>
      <li>Datos de recepción pendientes: {checklist.pendingFields.join(', ')||'Ninguno'}</li>
    </ul>
    {checklist.costs.filter(cost=>cost.disposition==='Pendiente').map(cost=><p key={cost.id} className="form-error">{cost.description} · {money(cost.amount)} · {cost.id}</p>)}
    {delivery?<section className="inline-note mt-4"><h3 className="font-semibold">Acta {delivery.id}</h3>
      <p>{delivery.exception?'Entrega por excepción':'Entrega ordinaria'} · {delivery.recipient}</p>
      <p>{delivery.evidence}</p><p>{delivery.reason}</p><small>Responsable {delivery.responsible_id} · {delivery.created_at}</small>
      <p>La revisión original quedó congelada con el acta; los pendientes no fueron eliminados.</p></section>:
      <form className="operation-form mt-4" onSubmit={event=>{
        event.preventDefault();if(sending.current)return;const fields=new FormData(event.currentTarget);
        const payload={orderId,expectedVersion:checklist.version,recipient:String(fields.get('recipient')),evidence:String(fields.get('evidence')),
          exception:fields.get('exception')==='on',reason:String(fields.get('reason')),creditReason:String(fields.get('creditReason')),
          acknowledgePendingReception:fields.get('acknowledgePendingReception')==='on'};
        const body=JSON.stringify(payload);if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
        sending.current=true;setBusy(true);setError('');
        void deliverOrder(payload,attempt.current.key).then(async delivery=>{setDelivery(delivery);await refresh();await reload();await onChange?.();})
          .catch(error=>setError(error.message)).finally(()=>{sending.current=false;setBusy(false);});
      }}><label className="form-field"><span>Persona que recibe el vehículo</span><input name="recipient" required/></label>
        <label className="form-field"><span>Evidencia y observaciones de entrega</span><textarea name="evidence" required/></label>
        <label><input type="checkbox" name="exception"/> Solicitar entrega por excepción (solo gerencia)</label>
        <label className="form-field"><span>Motivo de excepción</span><textarea name="reason"/></label>
        <label className="form-field"><span>Autorización de crédito y motivo</span><textarea name="creditReason"/></label>
        {!!checklist.pendingFields.length&&<label><input type="checkbox" name="acknowledgePendingReception" required/>
          Revisé los datos de recepción pendientes; se conservarán como pendientes en el acta.</label>}
        <Button type="submit" disabled={busy||checklist.openTimers.length>0}>Confirmar entrega revisada</Button>
      </form>}
    </>}
    {error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </section>;
}
