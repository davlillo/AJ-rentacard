'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ArrowRight,Check,FileText} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {Button} from '@/components/ui/button';
import {PageHeading} from '@/components/molecules/page-heading';
import {reservationCommand} from '@/lib/supabase/reservations';
import {rentalHref} from '@/lib/supabase/cases';
import {creationPayload,createRentalAttempt,saveRentalDraft,confirmRentalDraft,
  type RentalCreationInput,type RentalCreationAttempt,type CreationJournal} from '@/controladores/rental-create';
import {rentalAgreementTotals} from '@/controladores/rental-lifecycle';
import {rentalDocument} from '@/lib/documents/rental-document';
import {RentalDocumentExport} from '@/components/organisms/rental-document-export';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import styles from './rental-create-screen.module.css';

const journalKey='aj-rental-create-recovery-v1';
const emptyInput:RentalCreationInput={customerId:'',vehicleId:'',startsAt:'',endsAt:'',
  openEnded:false,dailyRate:'',cleaningMinutes:'60'};
const steps=['Datos del alquiler','Revisar acuerdo','Confirmar reserva'];

export function RentalCreateScreen(){
  const {data,can,source,open}=useBusiness();const router=useRouter();
  const [input,setInput]=useState(emptyInput);
  const [stage,setStage]=useState(0);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [ready,setReady]=useState(false);const [recovery,setRecovery]=useState<CreationJournal|null>(null);
  const [saved,setSaved]=useState<RentalCreationAttempt['saved']>();
  const attempt=useRef<RentalCreationAttempt|null>(null);const sending=useRef(false);
  const heading=useRef<HTMLHeadingElement>(null);
  const dirty=Object.entries(input).some(([key,value])=>value!==emptyInput[key as keyof RentalCreationInput]);
  useEffect(()=>{
    try{
      const raw=sessionStorage.getItem(journalKey);
      if(raw){
        const parsed=JSON.parse(raw) as CreationJournal;
        // A malformed lock also blocks creation rather than risking duplicate business records.
        setRecovery({key:typeof parsed.key==='string'?parsed.key:'',
          id:typeof parsed.id==='string'?parsed.id:undefined});
      }
    }catch{setError('No se pudo recuperar el intento anterior. Revise los folios antes de continuar.');setRecovery({key:''});}
    setReady(true);
  },[]);
  useEffect(()=>{
    const protect=(event:BeforeUnloadEvent)=>{if(dirty&&!saved){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);
  },[dirty,saved]);
  useEffect(()=>{heading.current?.focus();},[stage,saved]);
  function change<K extends keyof RentalCreationInput>(key:K,value:RentalCreationInput[K]){
    setInput(current=>({...current,[key]:value}));setError('');
  }
  function review(){
    try{
      creationPayload(input);
      if(!data.customers.some(customer=>customer.id===input.customerId)||
        !data.vehicles.some(vehicle=>vehicle.id===input.vehicleId&&vehicle.inRentalFleet)){
        throw new Error('Seleccione un cliente activo y un vehículo incluido en la flota.');
      }
      setError('');setStage(1);
    }catch(cause){setError((cause as Error).message);}
  }
  async function submit(confirm=false){
    if(sending.current||!ready||recovery)return;
    if(!can('orders.write')||source!=='supabase'){setError('No tiene permiso para guardar alquileres operativos.');return;}
    sending.current=true;setBusy(true);setError('');
    try{
      if(!attempt.current)attempt.current=createRentalAttempt(creationPayload(input),()=>crypto.randomUUID());
      if(confirm){
        const confirmed=await confirmRentalDraft(attempt.current,reservationCommand);
        if(confirmed.status!=='Confirmada')throw new Error('No se confirmó la reserva. Abra el folio para revisar su estado.');
        router.push(rentalHref(confirmed.id));
      }else{
        const record=await saveRentalDraft(attempt.current,reservationCommand,value=>sessionStorage.setItem(journalKey,JSON.stringify(value)));
        setSaved(record);setStage(2);
      }
    }catch(cause){
      // A saved identity survives even if the recovery-journal update failed.
      if(attempt.current?.saved){setSaved(attempt.current.saved);setStage(2);}
      setError((cause as Error).message);
    }finally{sending.current=false;setBusy(false);}
  }
  const customer=data.customers.find(customer=>customer.id===input.customerId);
  const vehicle=data.vehicles.find(vehicle=>vehicle.id===input.vehicleId);
  // The agreed total follows the same formula as the server: rate times the rounded up days of 24 hours.
  let agreement:{days:number|null;total:number|null}={days:null,total:null};
  try{const payload=creationPayload(input);
    agreement=rentalAgreementTotals(String(payload.startsAt),payload.endsAt===null?null:String(payload.endsAt),Number(input.dailyRate));}
  catch{agreement={days:null,total:null};}
  // The client detail exists at agreement time: it is the same client-safe projection of the folio.
  const clientDocument=rentalDocument({
    folioNumber:saved?.folio_number,
    customerName:customer?.name??'',
    vehicleLabel:vehicle?`${vehicle.brand} ${vehicle.model}`:'',
    plate:vehicle?.plate,
    startsOn:input.startsAt.slice(0,10),
    endsOn:input.openEnded?null:input.endsAt.slice(0,10),
    days:agreement.days,
    agreedAmount:agreement.total,
    issuedAmount:null,appliedAmount:null,pendingAmount:null,
    openEnded:input.openEnded,
    statusLabel:saved?.status,
    createdAt:new Date().toISOString(),
  });
  if(!can('orders.read'))return <section role="alert"><h1>Acceso restringido</h1><p>No tiene permiso para consultar alquileres.</p></section>;
  return <div className={styles.screen}>
    <PageHeading title="Nuevo alquiler" description="Prepare el acuerdo, guarde el borrador y confirme la reserva. La entrega se registra después."/>
    <nav aria-label="Etapas de creación" className={styles.stages}><ol>
      {steps.map((label,index)=><li key={label} data-complete={index<stage} aria-current={index===stage?'step':undefined}>
        <button type="button" disabled={busy||!!attempt.current||index>stage||!!recovery}
          onClick={()=>setStage(index)} aria-label={`Paso ${index+1}: ${label}`}>
          <span className={styles.circle}>{index<stage?<Check size={18} aria-hidden/>:index+1}</span><span>{label}</span>
        </button>{index<steps.length-1&&<ArrowRight className={styles.arrow} size={18} aria-hidden/>}
      </li>)}
    </ol></nav>
    {!ready?<p role="status">Recuperando formulario…</p>:recovery?<section className={styles.paper}>
      <h2 ref={heading} tabIndex={-1}>Hay un intento anterior pendiente de revisión</h2>
      <p>Para evitar duplicados, no se enviará otra creación al recargar. Revise el folio guardado o busque el intento en Alquileres antes de iniciar otro.</p>
      <Button asChild><Link href={recovery.id?rentalHref(recovery.id):'/alquileres/'}>{recovery.id?'Abrir folio guardado':'Revisar folios'}</Link></Button>
      {recovery.id&&<Button variant="outline" onClick={()=>{sessionStorage.removeItem(journalKey);setRecovery(null);}}>Iniciar otro alquiler</Button>}
    </section>:<div className={styles.layout}>
      <section className={styles.paper} aria-busy={busy}>
        <div className={styles.paperHeading}><FileText size={22} aria-hidden/><div><span>ACUERDO DE ALQUILER</span>
          <h2 ref={heading} tabIndex={-1}>{saved?folio('ALQ',saved.folio_number):steps[stage]}</h2></div>
          <strong className={styles.stamp}>{saved?'Borrador guardado':'Sin guardar'}</strong></div>
        {stage===0?<form className={styles.form} onSubmit={event=>{event.preventDefault();review();}}>
          <fieldset disabled={busy||!can('orders.write')||source!=='supabase'}>
            <legend>Cliente y vehículo</legend>
            <label className="form-field"><span>Cliente del alquiler</span><select aria-label="Cliente del alquiler" required value={input.customerId} onChange={event=>change('customerId',event.target.value)}>
              <option value="">Seleccionar cliente</option>{data.customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <div className={styles.customerAction}><span>¿El cliente no está registrado?</span>
              <Button type="button" variant="outline" disabled={!can('customers.write')} onClick={()=>open('cliente')}>Nuevo cliente</Button></div>
            <p className={styles.hint}>Después de guardar el cliente en el modal, selecciónelo aquí. No se perderán las fechas del acuerdo.</p>
            <label className="form-field"><span>Vehículo del alquiler</span><select aria-label="Vehículo del alquiler" required value={input.vehicleId} onChange={event=>{
              const selected=data.vehicles.find(vehicle=>vehicle.id===event.target.value);
              setInput(current=>({...current,vehicleId:event.target.value,dailyRate:selected?String(selected.daily):''}));
            }}><option value="">Seleccionar vehículo</option>{data.vehicles.filter(vehicle=>vehicle.inRentalFleet).map(vehicle=>
              <option key={vehicle.id} value={vehicle.id}>{vehicle.plate} · {vehicle.brand} {vehicle.model}</option>)}</select></label>
          </fieldset>
          <fieldset disabled={busy||!can('orders.write')||source!=='supabase'}><legend>Fechas y tarifa acordada</legend>
            <p className={styles.hint}>Horario de El Salvador (UTC−6). La disponibilidad se verifica al confirmar.</p>
            <div className={styles.fields}><label className="form-field"><span>Entrega prevista</span><input type="datetime-local" required value={input.startsAt} onChange={event=>change('startsAt',event.target.value)}/></label>
              {!input.openEnded&&<label className="form-field"><span>Devolución prevista</span><input type="datetime-local" required value={input.endsAt} onChange={event=>change('endsAt',event.target.value)}/></label>}</div>
            <label className={styles.check}><input type="checkbox" checked={input.openEnded} onChange={event=>change('openEnded',event.target.checked)}/> Sin fecha final definida</label>
            <div className={styles.fields}><label className="form-field"><span>Tarifa diaria acordada (USD)</span><input type="number" required min="0" step="0.01" value={input.dailyRate} onChange={event=>change('dailyRate',event.target.value)}/></label>
              <label className="form-field"><span>Limpieza posterior (minutos)</span><input type="number" required min="0" max="10080" step="1" value={input.cleaningMinutes} onChange={event=>change('cleaningMinutes',event.target.value)}/></label></div>
          </fieldset>
          <Button type="submit" disabled={!can('orders.write')||source!=='supabase'}>Revisar acuerdo <ArrowRight size={16}/></Button>
        </form>:<div className={styles.review}>
          <p>{saved?'El borrador existe, pero todavía no bloquea las fechas. Confirme la reserva para comprobar disponibilidad.':'Revise los datos antes de guardar. Este paso no confirma la reserva ni entrega el vehículo.'}</p>
          <dl><div><dt>Cliente</dt><dd>{customer?.name}</dd></div><div><dt>Vehículo</dt><dd>{vehicle?.plate} · {vehicle?.model}</dd></div>
            <div><dt>Entrega · El Salvador</dt><dd>{input.startsAt.replace('T',' · ')}</dd></div>
            <div><dt>Devolución · El Salvador</dt><dd>{input.openEnded?'Sin fecha final definida':input.endsAt.replace('T',' · ')}</dd></div>
            <div><dt>Tarifa diaria</dt><dd>{money(Number(input.dailyRate))}</dd></div></dl>
          <div className={styles.actions}>{saved?<>
            <Button disabled={busy||!can('orders.write')} onClick={()=>void submit(true)}>{busy?'Confirmando…':'Confirmar reserva y abrir folio'}</Button>
            <Button variant="outline" asChild><Link href={rentalHref(saved.id)}>Continuar en el folio sin confirmar</Link></Button>
          </>:<>
            <Button disabled={busy||!can('orders.write')} onClick={()=>void submit()}>{busy?'Guardando…':attempt.current?'Reintentar el mismo borrador':'Guardar borrador'}</Button>
            <Button variant="outline" disabled={busy||!!attempt.current} onClick={()=>setStage(0)}>Corregir datos</Button>
          </>}</div>
          {saved&&<section className={styles.clientDocument} aria-label="Detalle del alquiler para el cliente">
            <h3>Detalle para el cliente</h3>
            <p>Este es el documento que el cliente recibe antes de entregar el vehículo: entrégueselo con el carro.
              Descárguelo al confirmar la reserva: generarlo no emite cargos, no registra cobros y no guarda nada en el servidor.
              El importe acordado sale de la tarifa y de las fechas pactadas; el folio confirmado es la fuente oficial.</p>
            <RentalDocumentExport document={clientDocument}/>
          </section>}
          {attempt.current&&!saved&&<p className={styles.hint}>Si la respuesta se perdió, reintente con los mismos datos. No inicie otro alquiler para el mismo acuerdo.</p>}
        </div>}
      </section>
    </div>}
    {error&&<p className={styles.error} role="alert">{error}</p>}
    {!can('orders.write')&&<p role="status">No tiene permiso para crear alquileres.</p>}
    <Link className={styles.back} href="/alquileres/" onClick={event=>{
      if(dirty&&!saved&&!window.confirm('Hay datos sin guardar. ¿Desea volver a los folios?'))event.preventDefault();
    }}>← Volver a los folios</Link>
  </div>;
}
