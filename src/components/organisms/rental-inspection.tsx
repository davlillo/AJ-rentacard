'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {loadRentalInspections,rentalRpc,issueRentalExtra,type RentalInspection,type RentalExtra,type Reservation} from '@/lib/supabase/reservations';
import {money} from '@/controladores/finanzas';
import {AdaptiveTable} from './adaptive-table';
import {rentalDateTime} from '@/controladores/rental-workflow';
import {rentalAddDays} from '@/controladores/rental-issue-modal';
import {localToday} from '@/lib/supabase/billing';
import {VehicleReviewNotes} from './vehicle-review';
import {confirmInspection,inspectionBaseline,readingLabel,startInspection,type InspectionDraft,type InspectionConfirmation} from '@/controladores/rental-inspection-flow';
import styles from './rental-inspection.module.css';
import {Disclosure} from '@/components/organisms/disclosure';

export function RentalInspectionReview({booking,onChange}:{booking:Reservation;onChange:()=>Promise<void>}){
  return <InspectionReview key={booking.id} booking={booking} onChange={onChange}/>;
}

// The state of an extra, said plainly: an approved extra that still has no document is a pending
// charge, and an approved extra that already has its document was issued and is collectible.
export function rentalExtraState(extra:RentalExtra):string{
  if(extra.status==='Aprobado'){
    if(extra.document_id)return 'Aprobado · emitido';
    if(!extra.amount||Number(extra.amount)<=0)return 'Aprobado · importe por revisar';
    return 'Aprobado · pendiente de emitir';
  }
  return extra.status;
}

// Only an approved extra with an amount and no document yet can be issued.
export function rentalExtraCanIssue(extra:RentalExtra):boolean{
  return extra.status==='Aprobado'&&!extra.document_id&&!!extra.amount&&Number(extra.amount)>0;
}

function InspectionReview({booking,onChange}:{booking:Reservation;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const [inspections,setInspections]=useState<RentalInspection[]>([]);const [extras,setExtras]=useState<RentalExtra[]>([]);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  const issuance=useRef<{body:string;key:string}|null>(null);
  const [draft,setDraft]=useState<InspectionDraft|null>(null);const [confirmation,setConfirmation]=useState<InspectionConfirmation|null>(null);
  const [saved,setSaved]=useState<Reservation|null>(null);const [notice,setNotice]=useState('');
  const current=saved&&saved.version>=booking.version?saved:booking;
  const baseline=inspectionBaseline(current,inspections);
  const outgoing=inspections.find(inspection=>inspection.kind==='Salida');
  async function reload(){const result=await loadRentalInspections(booking.id);setInspections(result.inspections);setExtras(result.extras);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[booking.id]);
  function begin(intent:'departure'|'return'){
    try{setDraft(startInspection(current,intent));setConfirmation(null);setError('');attempt.current=null;}
    catch(error){setError((error as Error).message);}
  }
  async function submit(command:string,payload:Record<string,unknown>){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    try{
      const result=await rentalRpc<{reservation?:Reservation;inspection?:RentalInspection;return?:RentalInspection;cleaningConflict?:boolean}>(
        'execute_rental_command',{command,payload,idempotency_key:attempt.current.key});
      if(command==='depart'||command==='return'){
        setDraft(null);setConfirmation(null);
        if(result.reservation)setSaved(result.reservation);
        const record=result.inspection??result.return;
        if(record)setInspections(previous=>[...previous.filter(item=>item.id!==record.id),record]);
        setNotice(result.cleaningConflict?'Devolución guardada. El vehículo sigue retenido por un compromiso en conflicto: revise y reprograme el bloqueo. El saldo pendiente se conserva.':
          command==='depart'?'Salida guardada. La devolución requiere iniciar una inspección nueva.':'Devolución guardada. El saldo pendiente se conserva.');
      }
      await reload();await onChange();
    }
    catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  // The amount of an approved extra becomes a collection document. The amount is never sent by the
  // client: the server issues the one the approval decided. A retry keeps the same key.
  async function issue(extra:RentalExtra,payload:Record<string,unknown>){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({payload});if(issuance.current?.body!==body)issuance.current={body,key:crypto.randomUUID()};
    try{
      await issueRentalExtra(payload,issuance.current.key);
      issuance.current=null;
      setNotice('Documento de cobro del extra emitido. No se recibió dinero: el importe queda pendiente de cobro.');
      await reload();await onChange();
    }
    catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  return <section className="mt-6"><h3 className="font-semibold">{booking.rental_state==='Entregado'?'Registrar devolución del vehículo':booking.rental_state==='Preparado'?'Entrega del vehículo al cliente':'Inspecciones registradas'}</h3>
    <p className="field-hint">{booking.rental_state==='Entregado'?'Complete la inspección para terminar el uso del vehículo. El saldo pendiente se conserva.':'La entrega inicia el alquiler. La devolución termina su uso, pero no registra un cobro.'}</p>
    <div className="table-scroll mt-3"><AdaptiveTable className={styles.history}><thead><tr><th>Inspección</th><th>Revisión general</th></tr></thead>
      <tbody>{inspections.map(inspection=><tr key={inspection.id}><td>{inspection.kind==='Retorno'?'Devolución':'Entrega al cliente'}<small>{rentalDateTime(inspection.occurred_at)}</small></td>
        <td><p className="field-hint">Kilometraje: {readingLabel(inspection.km,'km')} · Combustible: {readingLabel(inspection.fuel,'%')}</p>
          <VehicleReviewNotes {...inspection} km={null} fuel={null}/></td></tr>)}</tbody></AdaptiveTable></div>
    {notice&&<p className="inline-note mt-4" role="status">{notice}</p>}
    {booking.status==='Borrador'&&<p className="inline-note mt-4">Confirme primero la reserva en Resumen para habilitar la entrega.</p>}
    {booking.status==='Confirmada'&&booking.rental_state==='Preparado'&&<p className="inline-note mt-4">Entrega prevista: {rentalDateTime(booking.starts_at)} (El Salvador). Solo se permite entregar dentro del período reservado y con el vehículo listo.</p>}
    {!draft&&can('orders.write')&&current.status==='Confirmada'&&['Preparado','Entregado'].includes(current.rental_state)&&
      <Button className="mt-4" type="button" disabled={busy} onClick={()=>begin(current.rental_state==='Preparado'?'departure':'return')}>
        {current.rental_state==='Preparado'?'Iniciar salida':'Iniciar devolución'}</Button>}
    {draft&&<form className="operation-form" onSubmit={event=>{
      event.preventDefault();
      try{setConfirmation(confirmInspection(draft,baseline));setError('');}
      catch(error){setError((error as Error).message);}
    }}><fieldset className={styles.draft} disabled={busy||!can('orders.write')}>
      <legend>{draft.intent==='departure'?'Inspección de salida':'Inspección de devolución'}</legend>
      <p className="field-hint">{draft.folio} · {draft.customer} · {draft.vehicle}</p>
      {current.version!==draft.expectedVersion&&<p className="inline-note" role="status">El folio cambió. Su borrador se conserva con la versión original; no se convertirá en otra operación. Revise el estado antes de reintentar.</p>}
      {draft.intent==='return'&&<div className="inline-note"><strong>Comparación con la salida guardada</strong>
        <p>Kilometraje: {readingLabel(outgoing?.km,'km')} · Combustible: {readingLabel(outgoing?.fuel,'%')}</p>
        {outgoing&&<VehicleReviewNotes {...outgoing} km={null} fuel={null}/>}
      </div>}
      <p className="field-hint">Último kilometraje conocido: {readingLabel(baseline,'km')}. Las lecturas se guardan por separado de las observaciones.</p>
      <div className={styles.readings}>
        <label className="form-field"><span>Kilometraje (km)</span><input name="km" type="number" required min={baseline??0} max="2147483647" step="1"
          value={draft.km} readOnly={Boolean(confirmation)} onChange={event=>setDraft({...draft,km:event.target.value})}/></label>
        <label className="form-field"><span>Combustible (%)</span><input name="fuel" type="number" required min="0" max="100" step="0.01"
          value={draft.fuel} readOnly={Boolean(confirmation)} onChange={event=>setDraft({...draft,fuel:event.target.value})}/></label>
      </div>
      <label className="form-field"><span>Revisión general del vehículo (360°)</span>
        <textarea name="review" aria-label="Revisión general del vehículo (360°)" required maxLength={4000} rows={6} value={draft.review} readOnly={Boolean(confirmation)}
          onChange={event=>setDraft({...draft,review:event.target.value})}
          placeholder="Describa daños, accesorios, documentos, herramientas, luces y otras observaciones."/>
      </label>
      {!confirmation?<Button type="submit">{draft.intent==='departure'?'Registrar entrega':'Registrar devolución'}</Button>:
        <section className={styles.confirmation} aria-label="Confirmación de inspección">
          <h4>Confirmar {confirmation.command==='depart'?'salida al cliente':'devolución del cliente'}</h4>
          <p>{confirmation.folio} · {confirmation.customer} · {confirmation.vehicle}</p>
          <p>Revisión previa: {rentalDateTime(confirmation.reviewedAt)} (El Salvador). La hora real se registra al guardar.</p>
          <p>Kilometraje: {readingLabel(Number(confirmation.payload.km),'km')} · Combustible: {readingLabel(Number(confirmation.payload.fuel),'%')}</p>
          <p>Esta operación no registra cobros. {confirmation.command==='return'?'El saldo pendiente se conserva.':'El vehículo quedará entregado al cliente.'}</p>
          <div className={styles.actions}>
            <Button type="button" onClick={()=>void submit(confirmation.command,confirmation.payload)}>
              {confirmation.command==='depart'?'Confirmar salida':'Confirmar devolución'}</Button>
            <Button type="button" variant="outline" onClick={()=>setConfirmation(null)}>Volver al borrador</Button>
          </div>
        </section>}
      <Button type="button" variant="outline" onClick={()=>{setDraft(null);setConfirmation(null);setError('');attempt.current=null;}}>
        Descartar borrador</Button>
    </fieldset></form>}
    {extras.length>0&&<Disclosure label={`Diferencias detectadas en la inspección · ${extras.map(extra=>rentalExtraState(extra)).join(' · ')}`}>
      <p className="field-hint mt-3">Estos extras solo existen cuando la inspección detectó una diferencia (un daño, un accesorio o combustible).
        Si no va a cobrarlo, elija Rechazado y explique por qué.</p>
      {extras.map(extra=><article key={extra.id} className="inline-note mt-3"><strong>{extra.description} · {rentalExtraState(extra)}</strong>
        <p>{extra.status==='Rechazado'?'No se cobra':extra.amount===null?'Importe por revisar':money(extra.amount)} · {extra.reason}</p>
        {extra.status==='Propuesto'&&can('expenses.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
          const decision=String(f.get('decision'));
          const amount=String(f.get('amount')??'').trim();
          // Approving an extra needs a price; rejecting one never does.
          if(decision==='Aprobado'&&!(Number(amount)>0)){setError('Indique el importe del extra que se va a cobrar.');return;}
          void submit('decide_extra',{proposalId:extra.id,expectedVersion:extra.version,decision,amount:decision==='Aprobado'?amount:null,reason:String(f.get('reason'))});
        }}><label className="form-field"><span>Decisión del extra</span><select aria-label="Decisión del extra" name="decision"><option>Aprobado</option><option>Rechazado</option></select></label>
          <label className="form-field"><span>Importe que se va a cobrar (USD)</span><input name="amount" type="number" min="0.01" step="0.01" placeholder="Solo si lo apruebas"/></label>
          <label className="form-field"><span>Motivo y autorización del extra</span><input name="reason" required/></label><Button type="submit" variant="outline" disabled={busy}>Guardar decisión del extra</Button>
        </form>}
        {rentalExtraCanIssue(extra)&&can('expenses.write')&&can('orders.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
          void issue(extra,{proposalId:extra.id,expectedVersion:extra.version,date:String(f.get('date')??''),
            dueOn:String(f.get('dueOn')??''),reason:String(f.get('reason')??'')});
        }}><label className="form-field"><span>Fecha de emisión del extra</span><input name="date" type="date" required defaultValue={localToday()}/></label>
          <label className="form-field"><span>Fecha de vencimiento</span><input name="dueOn" type="date" required defaultValue={rentalAddDays(localToday(),14)}/></label>
          <label className="form-field"><span>Motivo de la emisión</span><input name="reason" required/></label>
          <p className="field-hint">Registra el documento de cobro de {money(extra.amount??0)}. No recibe dinero: el importe queda pendiente de cobro.</p>
          <Button type="submit" variant="outline" disabled={busy}>Emitir el importe del extra</Button>
        </form>}
      </article>)}
    </Disclosure>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </section>;
}
