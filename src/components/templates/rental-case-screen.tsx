'use client';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {RentalInspectionReview} from '@/components/organisms/rental-inspection';
import {RentalContracts} from '@/components/organisms/rental-contracts';
import {RentalPeriods} from '@/components/organisms/rental-periods';
import {CaseFiles} from './vehicle-case-screen';
import {loadRentalCase,vehicleHref,type CaseFile} from '@/lib/supabase/cases';
import {reservationCommand,salvadorDateTime,type Reservation,type ReservationEvidence,type ReservationCommand} from '@/lib/supabase/reservations';
import {readRows} from '@/lib/supabase/business';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {RentalOperation,RentalCollection,RentalDates} from '@/components/organisms/rental-operation';
import {VehicleReleaseReview} from '@/components/organisms/vehicle-release-review';
import {RentalStageProgress} from '@/components/organisms/rental-stage-progress';
import {RentalAccounts,RentalBillingDetail} from '@/components/organisms/rental-accounts';
import {rentalDateTime,rentalSection,rentalSectionStage,rentalWorkflow,type RentalSection} from '@/controladores/rental-workflow';
import {rentalExtensionPreview,type RentalExtensionPreview} from '@/controladores/rental-extension-preview';
import {rentalElapsed,rentalLifecycle,rentalMoneyEvidence,rentalStages} from '@/controladores/rental-lifecycle';
import {stageAdvance,typingInFolio} from '@/controladores/stage-advance';
import {Disclosure} from '@/components/organisms/disclosure';
import {rentalDocument,type RentalDocumentFacts} from '@/lib/documents/rental-document';
import {RentalDocumentExport} from '@/components/organisms/rental-document-export';
import styles from './rental-case-screen.module.css';

export function RentalCaseScreen(){const id=useSearchParams().get('id')??'';return <RentalContent key={id} id={id}/>;}
// The document shows the local rental dates, not the UTC storage timestamps.
function localDate(value?:string|null):string|null{
  if(!value)return null;
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/El_Salvador'}).format(date);
}
// The derived stage of the folio, readable outside the render scope so the advance
// effect compares the same value the screen shows before and after a reload.
function rentalCurrentStage(file:CaseFile,financialAccess:boolean):number|null{
  const booking=file.reservations[0];if(!booking)return null;
  const visible=financialAccess?file:{...file,financialAccess:false,documents:[],applications:[],payments:[],advances:[],expenses:[]};
  const flow=rentalWorkflow(booking,file.commitments);
  return rentalLifecycle(booking,flow,rentalMoneyEvidence(visible,booking,null)).currentIndex;
}
function RentalContent({id}:{id:string}){
  const {data,can,refresh,open,modal}=useBusiness();const [file,setFile]=useState<CaseFile|null>(null);
  const requestedSection=useSearchParams().get('seccion');
  const [loadError,setLoadError]=useState('');
  // One ordered flow: the circles are the only navigation and the selected stage shows its content.
  const [stage,setStage]=useState<number|null>(()=>requestedSection?rentalSectionStage(rentalSection(requestedSection)):null);
  const [finishReview,setFinishReview]=useState(false);
  const [openExtension,setOpenExtension]=useState(false);
  // After a successful action the folio moves to the stage that now applies and says so.
  const [actionReload,setActionReload]=useState(0);const [advanceNotice,setAdvanceNotice]=useState('');
  const sequence=useRef(0);const manualAt=useRef(0);const actionAt=useRef(0);
  const previousCurrent=useRef<number|null>(null);const currentStageRef=useRef<number|null>(null);
  const folioRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{setStage(requestedSection?rentalSectionStage(rentalSection(requestedSection)):null);},[requestedSection]);
  const readRevision=useRef(0);
  const readCase=useCallback(async()=>{const revision=++readRevision.current;
    try{const result=await loadRentalCase(id);if(revision===readRevision.current){setFile(result);setLoadError('');}}
    catch(error){if(revision===readRevision.current)throw error;}
  },[id]);
  const readAndRefresh=useCallback(async()=>{await readCase();await refresh();},[readCase,refresh]);
  // Every caller of `reload` runs it after its own command succeeded: that reload is the
  // only trigger of the automatic advance.
  const reload=useCallback(async()=>{actionAt.current=++sequence.current;
    previousCurrent.current=currentStageRef.current;await readAndRefresh();setActionReload(value=>value+1);},[readAndRefresh]);
  const {busy,error,execute}=useCaseAction(reload);
  function mutate(command:ReservationCommand,payload:Record<string,unknown>){return execute(`reservation.${command}`,payload,key=>reservationCommand(command,payload,key));}
  // A legacy section or an action of the operation resolves to the stage that owns it now.
  const goToSection=(section:RentalSection)=>setStage(rentalSectionStage(section));
  const financialAccess=!!file&&file.financialAccess&&can('expenses.read');
  const currentStage=file?rentalCurrentStage(file,financialAccess):null;
  currentStageRef.current=currentStage;
  useEffect(()=>{
    if(!actionReload||!file)return;
    const decision=stageAdvance({previous:previousCurrent.current,current:currentStage,confirmed:true,
      dirty:typingInFolio(folioRef.current),manual:manualAt.current>actionAt.current});
    if(decision.advance&&decision.stage!==null){
      setStage(decision.stage);setFinishReview(false);
      setAdvanceNotice(`Avanzó a: ${rentalStages[decision.stage]}`);
    }
  },[actionReload]);
  function pickStage(index:number|null){
    manualAt.current=++sequence.current;setAdvanceNotice('');
    setStage(index);setFinishReview(false);
  }
  useEffect(()=>{let active=true;if(id)void readCase().catch(error=>{if(active)setLoadError(error.message);});
    return()=>{active=false;readRevision.current++;};},[id,readCase,modal.kind,data]);
  if(!id)return <p role="alert" className="form-error">Falta el identificador del alquiler.</p>;
  if(!file)return <p role={loadError?'alert':'status'}>{loadError||'Cargando pliego del alquiler…'}</p>;
  const booking=file.reservations[0];const car=file.vehicle;
  const visibleFile=financialAccess?file:{...file,financialAccess:false,documents:[],applications:[],payments:[],advances:[],expenses:[]};
  const flow=rentalWorkflow(booking,file.commitments);
  // Money evidence comes from the persisted scope and only with the current permission.
  const evidence=rentalMoneyEvidence(visibleFile,booking,null);
  const lifecycle=rentalLifecycle(booking,flow,evidence);
  const accounts=lifecycle.accounts;
  const shown=stage??currentStage??0;
  // The closing stage states the status once: operational closure, the pending amount and,
  // while the vehicle is retained, that the release is confirmed from the vehicle dossier.
  const pendingNote=financialAccess&&accounts?(accounts.pending>0?`Pendiente por cobrar: ${money(accounts.pending)}.`:'Sin saldo pendiente por cobrar.'):'Requiere acceso a los importes para ver el saldo.';
  const elapsed=rentalElapsed(booking,Date.now());
  const duration=booking.open_ended?'Sin duración definida (alquiler sin fin)':
    elapsed.plannedDays===null?'Por definir':`${elapsed.plannedDays} ${elapsed.plannedDays===1?'día':'días'}`;
  // The document reuses the very same persisted evidence as the Cuentas section.
  const documentFacts:RentalDocumentFacts={folioNumber:booking.folio_number,customerName:booking.customer_snapshot.name,
    vehicleLabel:`${car.brand} ${car.model}`,plate:car.plate,startsOn:localDate(booking.starts_at),endsOn:localDate(booking.ends_at),
    days:booking.open_ended?null:elapsed.plannedDays,agreedAmount:booking.open_ended?null:Number(booking.total)||0,
    issuedAmount:evidence?evidence.charged:null,appliedAmount:evidence?evidence.paid:null,pendingAmount:evidence?evidence.balance:null,
    openEnded:!!booking.open_ended,statusLabel:booking.rental_state,createdAt:booking.created_at};
  // The operation carries the next action, so it stays where the rental still waits for one.
  const operation=<RentalOperation file={visibleFile} onChange={reload} onSection={goToSection} busy={busy}
    onFinish={()=>setFinishReview(true)}
    onConfirm={()=>{void mutate('confirm',{reservationId:id,expectedVersion:booking.version});}}/>;
  return <div className={styles.folio} ref={folioRef}><nav aria-label="Ubicación del alquiler" className="mb-5"><Link href="/alquileres/">Alquileres</Link> / {folio('ALQ',booking.folio_number)} · <Link href={vehicleHref(car.id)}>{car.plate}</Link></nav>
    <PageHeading eyebrow="FOLIO DEL ALQUILER" title={`${folio('ALQ',booking.folio_number)} · ${car.plate}`}
      description={`${booking.customer_snapshot.name} · ${rentalWorkflow(booking,file.commitments).label}`}
      actions={<Button variant="outline" disabled={busy} onClick={()=>{void readAndRefresh().catch(error=>setLoadError(error.message));}}>Actualizar alquiler</Button>}/>
    <RentalStageProgress booking={booking} commitments={file.commitments} evidence={evidence}
      shown={shown} onReturnToCurrent={()=>pickStage(null)} onSelect={index=>pickStage(index)}/>
    {advanceNotice&&<p className={styles.advanceNotice} role="status">{advanceNotice}</p>}
    {shown===0&&<>
      <section className={styles.agreement} aria-label="Acuerdo del alquiler">
        <header className={styles.agreementHeader}>
          <div><span className="section-kicker">ACUERDO DEL ALQUILER</span>
            <h2>Acuerdo del alquiler</h2>
            <p>Lo pactado con el cliente: quién alquila, qué vehículo, cuándo se entrega y devuelve, y cuánto se acordó.</p></div>
          <span className={styles.agreementState}>{flow.label}</span>
        </header>
        <dl className={styles.agreementFacts}>
          <div><dt>Cliente</dt><dd>{booking.customer_snapshot.name}</dd></div>
          <div><dt>Vehículo</dt><dd>{car.brand} {car.model} · {car.plate}</dd></div>
          <div><dt>Entrega prevista</dt><dd>{rentalDateTime(booking.starts_at)}</dd></div>
          <div><dt>Devolución prevista</dt><dd>{booking.open_ended?'Sin fecha final definida':rentalDateTime(booking.ends_at)}</dd></div>
          <div><dt>Duración</dt><dd>{duration}</dd></div>
          <div><dt>Tarifa diaria</dt><dd>{money(booking.daily_rate)}</dd></div>
          <div><dt>Total acordado</dt><dd>{booking.open_ended?'Sin total final acordado; documentar por períodos':money(booking.total)}</dd></div>
          <div><dt>Estado del alquiler</dt><dd>{flow.label}</dd></div>
          <div><dt>Estado del vehículo</dt><dd>{car.status}</dd></div>
        </dl>
        <div className={styles.clientDocument}>
          <h3>Descargar el detalle para el cliente</h3>
          <p>Este es el documento informativo que el cliente recibe antes de que se le entregue el vehículo.
            Se genera en este dispositivo: no emite importes a cobrar, no registra cobros y no guarda nada en el servidor.</p>
          <RentalDocumentExport document={rentalDocument(documentFacts)}/>
        </div>
        <p className="inline-note mt-4">Pagar un período no libera el carro ni cancela la reserva. El alquiler sin fin acordado mantiene ocupación abierta.</p>
        <RentalAgreements key={'agreements:'+booking.id} booking={booking} onChange={reload}
          primary={booking.status!=='Borrador'}/>
        {booking.status!=='Cancelada'&&booking.rental_state==='Preparado'&&can('orders.write')&&
          <section className={styles.openBlock} aria-label="Cancelar reserva no entregada">
            <h3 className={styles.openBlockTitle}>Cancelar reserva no entregada</h3>
            <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
              void mutate('cancel',{reservationId:id,expectedVersion:booking.version,reason:String(f.get('reason'))});
            }}><label className="form-field"><span>Motivo de cancelación operativa</span><input name="reason" required/></label>
              <Button type="submit" variant="outline" disabled={busy}>Cancelar sin borrar deuda ni recibos</Button></form>
          </section>}
      </section>
      {(booking.status!=='Confirmada'||booking.rental_state==='Preparado')&&operation}
    </>}
    {shown===1&&<>
      {finishReview&&flow.action==='return'?<RentalFinishReview file={visibleFile}
        onBack={()=>setFinishReview(false)} onContinue={()=>{setFinishReview(false);setStage(2);}}/>:operation}
      <section className="mt-5" aria-label="Extensión del alquiler">
        <RentalExtension key={booking.id} booking={booking} onChange={reload} open={openExtension}
          onOpenChange={setOpenExtension} onCharges={()=>setStage(3)}/>
      </section>
    </>}
    {shown===2&&<section className="panel p-5" aria-label="Devolución del vehículo">
      <RentalInspectionReview booking={booking} onChange={reload}/>
      {['Devuelto','Cerrado'].includes(booking.rental_state)&&
        <div className="mt-5"><VehicleReleaseReview file={visibleFile} booking={booking} onChange={reload}/></div>}
    </section>}
    {shown===3&&<RentalAccounts file={visibleFile} booking={booking} onChange={reload}
      onOpenExtension={()=>{setStage(1);setOpenExtension(true);}}
      collectionSlot={financialAccess&&can('expenses.write')?<RentalCollection file={visibleFile} onChange={reload}/>:null}/>}
    {shown===4&&<>
      <section className="panel p-5" aria-label="Cierre del alquiler">
        <h2 className="font-semibold">Cierre del alquiler</h2>
        <p className="field-hint mt-3">{flow.action==='clean'
          ?`El alquiler quedó cerrado operativamente y el vehículo sigue retenido. ${pendingNote} Confirme abajo la entrega y la liberación del vehículo.`
          :`El alquiler está cerrado operativamente. ${pendingNote}`}</p>
        {['Devuelto','Cerrado'].includes(booking.rental_state)&&<div className={styles.releaseAction}>
          <VehicleReleaseReview file={visibleFile} booking={booking} onChange={reload}/>
        </div>}
        <dl className={styles.agreementFacts}>
          <div><dt>Folio</dt><dd>{folio('ALQ',booking.folio_number)}</dd></div>
          <div><dt>Cliente</dt><dd>{booking.customer_snapshot.name}</dd></div>
          <div><dt>Vehículo</dt><dd>{car.brand} {car.model} · {car.plate}</dd></div>
          <div><dt>Entrega</dt><dd>{booking.actual_departure_at?rentalDateTime(booking.actual_departure_at):rentalDateTime(booking.starts_at)}</dd></div>
          <div><dt>Devolución</dt><dd>{booking.actual_return_at?rentalDateTime(booking.actual_return_at):'Sin registro'}</dd></div>
          <div><dt>Total acordado</dt><dd>{booking.open_ended?'Sin total final acordado':money(booking.total)}</dd></div>
          <div><dt>Estado del vehículo</dt><dd>{car.status}</dd></div>
          <div><dt>Pendiente por cobrar</dt><dd>{accounts?money(accounts.pending):'Requiere acceso a los importes'}</dd></div>
        </dl>
      </section>
      {financialAccess&&<Disclosure className={styles.optionalBlock} label="Gastos de este alquiler"
        hint="Opcional · registre un gasto solo si pagó algo de este alquiler">
        {(file.expenses??[]).map(e=><p className="inline-note mt-4" key={e.id}>{e.date} · {e.id} · {e.concept} · {money(e.scope_amount??e.amount)}</p>)}
        {!file.expenses?.length&&<p className="mt-4">No hay gastos asignados a este alquiler.</p>}
        {can('expenses.write')&&<Button className="mt-4" variant="outline" onClick={()=>open('gasto',`reservation:${id}`)}>Registrar gasto en este alquiler</Button>}
      </Disclosure>}
      <div className={styles.closingFiles}>
        <Disclosure className={styles.optionalBlock} label="Fotos y documentos" hint="Opcional · guarde fotos o soportes">
          <CaseFiles file={file} reservationId={id} onChange={reload}/>
        </Disclosure>
      </div>
      <RentalContracts booking={booking} summary="Contrato del alquiler" hint="Opcional · condiciones y aceptación del contrato"/>
    </>}
    {(error||loadError)&&<p role="alert" className="form-error mt-4">{error||loadError}</p>}
  </div>;
}

function RentalFinishReview({file,onContinue,onBack}:{file:CaseFile;onContinue:()=>void;onBack:()=>void}){
  const {can}=useBusiness();const booking=file.reservations[0];const elapsed=rentalElapsed(booking,Date.now());
  return <section className="panel p-5" aria-label="Revisión para terminar alquiler">
    <span className="section-kicker">REVISIÓN · NO MODIFICA EL FOLIO</span>
    <h2 className="font-semibold">Terminar alquiler</h2>
    <RentalDates booking={booking}/>
    <dl className="detail-list mt-4">
      <div><dt>Tiempo hasta ahora</dt><dd>{elapsed.day===null?'Por revisar':`Día ${elapsed.day}${elapsed.plannedDays===null?'':` de ${elapsed.plannedDays}`}`}</dd></div>
      <div><dt>Precio previsto acordado</dt><dd>{booking.open_ended?'Sin total final acordado':money(booking.total)}</dd></div>
      <div><dt>Acumulado estimado · NO es importe emitido ni PAGO</dt><dd>{elapsed.estimate===null?'Por revisar':money(elapsed.estimate)}</dd></div>
    </dl>
    <p className="inline-note mt-4">Devolver antes no cambia automáticamente el precio ni los importes ya emitidos.
      Revise el importe acordado con el cliente. Continuar no emite importes a cobrar ni recibe dinero.</p>
    {file.financialAccess&&can('expenses.read')?<RentalBillingDetail file={file}/>:
      <p className="inline-note mt-4">Los importes documentados requieren permiso financiero. Puede continuar con la devolución operativa sin ese permiso.</p>}
    <div className={styles.actions}>
      <Button disabled={!can('orders.write')} onClick={onContinue}>Continuar con devolución</Button>
      <Button variant="outline" onClick={onBack}>Volver al alquiler</Button>
    </div>
    <p className="field-hint mt-3">A continuación registre kilometraje, combustible y observaciones, y confirme la devolución. Esto no cancela deuda.</p>
  </section>;
}

function RentalExtension({booking,onChange,onCharges,open=false,onOpenChange}:{
  booking:Reservation;onChange:()=>Promise<void>;onCharges:()=>void;open?:boolean;onOpenChange?:(open:boolean)=>void;
}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const [preview,setPreview]=useState<RentalExtensionPreview|null>(null);
  const [endsAt,setEndsAt]=useState('');const [reason,setReason]=useState('');const [validation,setValidation]=useState('');
  const [saved,setSaved]=useState(false);
  const allowed=booking.status==='Confirmada'&&['Preparado','Entregado'].includes(booking.rental_state);
  if(!can('orders.write')||(!allowed&&!preview))return null;
  return <Disclosure className={styles.extensionDisclosure} label="Extender o acordar la fecha de devolución"
    open={open} onOpenChange={onOpenChange}>
    <form className="operation-form" onSubmit={event=>{
      event.preventDefault();
      if(preview)return;
      try{setPreview(rentalExtensionPreview(booking,salvadorDateTime(endsAt),reason));setValidation('');setSaved(false);}
      catch(error){setValidation((error as Error).message);}
    }}><fieldset className={styles.form} disabled={busy}>
      <legend>Revisar fechas y precio previsto</legend>
      <label className="form-field"><span>Nueva fecha final acordada</span><input name="endsAt" type="datetime-local" required
        value={endsAt} readOnly={Boolean(preview)} onChange={event=>setEndsAt(event.target.value)}/></label>
      <label className="form-field"><span>Motivo del cambio de fecha</span><textarea name="extensionReason" aria-label="Motivo del cambio de fecha" required
        value={reason} readOnly={Boolean(preview)} onChange={event=>setReason(event.target.value)}/></label>
      {!preview?<Button type="submit">Revisar cambio de fecha e importe</Button>:<section className={styles.preview} aria-label="Revisión de extensión">
        <h3>{preview.command==='set_end'?'Acordar fin del alquiler abierto':'Confirmar extensión del alquiler'}</h3>
        <dl className="detail-list">
          <div><dt>Fin actual</dt><dd>{rentalDateTime(preview.currentEnd)}</dd></div>
          <div><dt>Nuevo fin propuesto</dt><dd>{rentalDateTime(preview.newEnd)}</dd></div>
          <div><dt>Precio previsto actual</dt><dd>{preview.currentForecast===null?'Sin total final acordado':money(preview.currentForecast)}</dd></div>
          <div><dt>Nuevo precio previsto</dt><dd>{money(preview.newForecast)}</dd></div>
          <div><dt>Diferencia prevista</dt><dd>{preview.difference===null?'Total por acordar; sin diferencia comparable':
            preview.difference===0?'Sin incremento previsto':money(preview.difference)}</dd></div>
        </dl>
        <p className="field-hint">{preview.days} períodos de 24 horas, redondeados hacia arriba desde la entrega prevista original.
          El servidor verifica nuevamente disponibilidad, versión y tarifa al confirmar.</p>
        <p className="inline-note">Este cambio NO emite un importe a cobrar ni registra un cobro. El importe previsto no es un saldo pendiente.
          Después revise y confirme el importe a cobrar del período aquí mismo, junto con la extensión y separado del recibo.</p>
        {booking.version!==preview.payload.expectedVersion&&<p role="status" className="inline-note">El folio cambió. Esta confirmación conserva su versión original; vuelva a revisar antes de guardar.</p>}
        <div className={styles.actions}><Button type="button" onClick={()=>{void execute('reservation.'+preview.command,preview.payload,
          key=>reservationCommand(preview.command,preview.payload,key)).then(ok=>{if(ok){setPreview(null);setEndsAt('');setReason('');setSaved(true);}});}}>
          Confirmar solo cambio de fecha</Button>
          <Button type="button" variant="outline" onClick={()=>setPreview(null)}>Volver a revisar fechas</Button></div>
      </section>}
      {saved&&<div className="inline-note" role="status">Fechas guardadas. No se creó ningún importe a cobrar ni cobro.
        {can('expenses.read')&&<button type="button" className="text-link" onClick={onCharges}>Revisar el detalle de facturación del folio →</button>}</div>}
      {(validation||error)&&<p className="form-error" role="alert">{validation||error}</p>}
    </fieldset></form>
    {allowed&&<section className={styles.extensionPeriods} aria-label="Documentar el período del alquiler">
      <h3>Documentar el período del alquiler</h3>
      <p>El importe a cobrar de un período se puede emitir desde Cuentas o desde aquí, dentro de las fechas acordadas.
        Documentar un período no registra cobros ni reemplaza los importes emitidos antes.</p>
      <RentalPeriods key={booking.id} booking={booking} onChange={onChange}/>
    </section>}
  </Disclosure>;
}

function RentalAgreements({booking,onChange,primary=false}:{booking:Reservation;onChange:()=>Promise<void>;primary?:boolean}){
  const {can}=useBusiness();const [notes,setNotes]=useState<ReservationEvidence[]>([]);const [loadError,setLoadError]=useState('');
  const reload=useCallback(async()=>{setNotes((await readRows<ReservationEvidence>('reservation_evidence','*')).filter(note=>note.reservation_id===booking.id));},[booking.id]);
  const {busy,error,execute}=useCaseAction(async()=>{await reload();await onChange();});
  useEffect(()=>{void reload().catch(error=>setLoadError(error.message));},[reload]);
  return <section className={styles.openBlock} aria-label="Acuerdos y observaciones del folio">
    <h3 className={styles.openBlockTitle}>Acuerdos y observaciones del folio</h3>
    {notes.map(note=><article className="inline-note mt-4" key={note.id}><p>{note.body}</p><small>{rentalDateTime(note.created_at)}</small></article>)}
    {can('orders.write')&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const body=String(new FormData(form).get('body'));
      const payload={reservationId:booking.id,body};
      void execute('reservation.evidence',payload,key=>reservationCommand('evidence',payload,key)).then(ok=>{if(ok)form.reset();});
    }}><label className="form-field"><span>Acuerdo u observaciones de la reserva</span><textarea name="body" required maxLength={20000}/></label>
      <Button type="submit" variant={primary?undefined:'outline'} disabled={busy}>Guardar acuerdo u observaciones</Button></form>}
    {(error||loadError)&&<p className="form-error" role="alert">{error||loadError}</p>}
  </section>;
}
