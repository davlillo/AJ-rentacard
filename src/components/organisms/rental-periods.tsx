'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {readRows} from '@/lib/supabase/business';
import {rentalRpc,reservationCommand,type Reservation} from '@/lib/supabase/reservations';
import {loadBilling,localToday,type Receivable} from '@/lib/supabase/billing';
import {money} from '@/controladores/finanzas';
import {reviewRentalPeriod,type PeriodInput} from '@/controladores/rental-lifecycle';
import {rentalAddDays as addDays,rentalIssueAttempt,rentalIssueBody,rentalIssueConsequence,
  rentalIssueDatesDisclosure,
  rentalIssueEmptyPeriod,rentalIssueFacts,rentalIssuePeriod,rentalIssuePrefill,rentalIssueReasonHint,rentalIssueSubmitLabel,
  rentalIssueTitle,rentalLocalDate as localDate,rentalIssueEnd,type RentalIssueAttempt,type RentalIssueFacts,
  type RentalIssuePrefill} from '@/controladores/rental-issue-modal';
import styles from './rental-periods.module.css';

interface RentalPeriod {id:string;reservation_id:string;starts_on:string;ends_on:string;document_id:string;reason:string;}

export function RentalPeriods({booking,onChange,open=false,amount,summary='Documentar otro período de alquiler'}:{
  booking:Reservation;onChange?:()=>Promise<void>;open?:boolean;amount?:string;summary?:string;
}){
  const {can}=useBusiness();const [periods,setPeriods]=useState<RentalPeriod[]>([]);
  const [documents,setDocuments]=useState<Receivable[]>([]);const [paidThrough,setPaidThrough]=useState<string|null>(null);
  const [loadError,setLoadError]=useState('');
  const [review,setReview]=useState<ReturnType<typeof reviewRentalPeriod>|null>(null);
  const [validation,setValidation]=useState('');const [loading,setLoading]=useState(true);
  const reload=useCallback(async()=>{
    setPaidThrough(await rentalRpc('rental_paid_through',{reservation_id:booking.id}));
    if(can('expenses.read')){
      const periods=(await readRows<RentalPeriod>('rental_periods','*')).filter(p=>p.reservation_id===booking.id);
      setPeriods(periods);
      setDocuments((await loadBilling(localToday())).documents.filter(d=>d.reservation_id===booking.id||periods.some(p=>p.document_id===d.id)));
    }
  },[booking.id,can('expenses.read')]);
  const {busy,error,execute}=useCaseAction(async()=>{await reload();await onChange?.();});
  useEffect(()=>{setLoading(true);void reload().then(()=>setLoadError('')).catch(error=>setLoadError(error.message)).finally(()=>setLoading(false));},[reload]);
  // The agreed range of the rental is the calendar days it occupies: it starts on the agreed
  // delivery day and reaches the agreed return day. The return day is used as it is, not the day
  // before, because a rental delivered and returned on the same day occupies exactly one day and
  // subtracting one would put the end before the start. The next period continues the day after the
  // last documented one.
  const contractualStart=localDate(booking.starts_at);
  const contractualEnd=booking.open_ended?'':rentalIssueEnd(contractualStart,localDate(booking.ends_at));
  const documentedEnd=periods.reduce((latest,period)=>period.ends_on>latest?period.ends_on:latest,'');
  const startsOn=documentedEnd?addDays(documentedEnd,1):contractualStart;
  const endsOn=contractualEnd;
  const ready=!!startsOn&&!!endsOn&&startsOn<=endsOn&&(!contractualStart||startsOn>=contractualStart);
  // The agreed dates and the agreed amount are offered as a starting point. The operator's own
  // typing always wins: the prefill never overwrites a field that was already filled.
  const [values,setValues]=useState({startsOn:'',endsOn:'',amount:''});
  useEffect(()=>{
    if(loading||!ready)return;
    setValues(current=>current.startsOn&&current.endsOn?current:
      {...current,startsOn:current.startsOn||startsOn,endsOn:current.endsOn||endsOn,amount:current.amount||(amount??'')});
  },[loading,ready,startsOn,endsOn,amount]);
  return <section className="mt-5"><h3 className="font-semibold">Períodos documentados y pagado hasta</h3>
    <p className="inline-note mt-3">Pagado hasta: <strong>{paidThrough??'Sin cobertura conciliada'}</strong>.
      Se calcula con períodos continuos y documentos saldados. Una nota «cancelado hasta» no cancela el alquiler ni registra dinero.</p>
    {periods.map(period=>{const doc=documents.find(d=>d.id===period.document_id);return <p className="mt-3" key={period.id}>
      {period.starts_on} al {period.ends_on} · {doc?.grouped?'Documento agrupado: consultar el desglose de este alquiler':doc?`${money(doc.amount)} · Saldo ${money(doc.balance)}`:'Documento por consultar'} · {period.reason}</p>;})}
    {booking.status==='Confirmada'&&can('orders.write')&&can('expenses.write')&&<details className="mt-4" open={open}><summary>{summary}</summary>
      <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
        const input=Object.fromEntries(['startsOn','endsOn','date','dueOn','amount','reason'].map(key=>[key,String(f.get(key)??'')])) as unknown as PeriodInput;
        try{setReview(reviewRentalPeriod(booking,input,periods));setValidation('');}
        catch(error){setValidation((error as Error).message);}
      }}><fieldset disabled={busy||loading||!!loadError||!can('expenses.read')||!can('expenses.write')||!can('orders.write')} className="space-y-4">
        <legend>Período acordado aún no documentado</legend>
        <div className="form-grid"><label className="form-field"><span>Período desde (inclusive)</span><input type="date" name="startsOn" required readOnly={!!review} value={values.startsOn} onChange={event=>setValues(current=>({...current,startsOn:event.target.value}))}/></label>
          <label className="form-field"><span>Período hasta (inclusive)</span><input type="date" name="endsOn" required readOnly={!!review} value={values.endsOn} onChange={event=>setValues(current=>({...current,endsOn:event.target.value}))}/></label></div>
        <label className="form-field"><span>Importe acordado del período USD</span><input type="number" min="0.01" step="0.01" name="amount" required readOnly={!!review} value={values.amount} onChange={event=>setValues(current=>({...current,amount:event.target.value}))}/></label>
        <div className="form-grid"><label className="form-field"><span>Fecha de emisión del período</span><input type="date" name="date" required defaultValue={localToday()} readOnly={!!review}/></label>
          <label className="form-field"><span>Vencimiento del período</span><input type="date" name="dueOn" required defaultValue={localToday()} readOnly={!!review}/></label></div>
        <label className="form-field"><span>Acuerdo del período</span><textarea name="reason" required readOnly={!!review}/></label>
        {!review?<Button type="submit">Revisar importe a cobrar del período</Button>:<section className="inline-note" aria-label="Revisión del importe a cobrar">
          <h4>Confirmar importe manual acordado</h4>
          <p>{review.payload.startsOn} al {review.payload.endsOn} · {money(Number(review.payload.amount))}</p>
          <p>Emisión: {review.payload.date} · Vencimiento: {review.payload.dueOn}</p><p>{review.payload.reason}</p>
          <p>Emite un importe a cobrar nuevo; NO registra un cobro ni reemplaza los importes emitidos antes. El servidor vuelve a verificar fechas y superposición.</p>
          {booking.version!==review.payload.expectedVersion&&<p role="status">El folio cambió; vuelva a revisar el período.</p>}
          <div className="flex flex-wrap gap-3 mt-3"><Button type="button" disabled={busy||booking.version!==review.payload.expectedVersion}
            onClick={()=>{void execute('period',review.payload,key=>reservationCommand('period',review.payload,key)).then(saved=>{if(saved)setReview(null);});}}>
            Emitir importe a cobrar del período (no registra cobro)</Button>
            <Button type="button" variant="outline" onClick={()=>setReview(null)}>Volver a revisar período</Button></div>
        </section>}
        </fieldset>
      </form></details>}
    {can('expenses.read')&&<p className="mt-4"><Link href="/cobros">Consultar o aplicar recibos en Cobros</Link></p>}
    {(error||loadError||validation)&&<p role="alert" className="form-error mt-4">{error||loadError||validation}</p>}
  </section>;
}

// The issuing modal of the Cuentas section. It shows the facts the system already knows and asks
// the operator only for the amount, the emission date, the due date and the reason of the period.
// The submission is the canonical "period" command: same version, same idempotency key, same
// validations and same server messages.
export function RentalIssueModal({open,booking,vehicle,agreed,pending,pendingToEmit,onChange,onClose}:{
  open:boolean;booking:Reservation;vehicle:{plate?:string;brand?:string;model?:string}|null;
  agreed:number|null;pending:number;pendingToEmit:number;
  onChange?:()=>Promise<void>;onClose:()=>void;}){
  const {toast}=useBusiness();
  const [periods,setPeriods]=useState<RentalPeriod[]>([]);
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const attempt=useRef<RentalIssueAttempt|null>(null);
  useEffect(()=>{
    if(!open)return;
    let cancelled=false;
    setLoading(true);setError('');setLoadError('');
    readRows<RentalPeriod>('rental_periods','*')
      .then(rows=>{if(!cancelled)setPeriods(rows.filter(period=>period.reservation_id===booking.id));})
      .catch(failure=>{if(!cancelled)setLoadError((failure as Error).message);})
      .finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[open,booking.id]);
  const period=rentalIssuePeriod(booking,periods);
  const prefill=rentalIssuePrefill(period,localToday(),agreed,pendingToEmit);
  const rate=Number(booking.daily_rate);
  const facts=rentalIssueFacts(booking,vehicle,period,{agreed,pending,pendingToEmit},
    Number.isFinite(rate)?rate:null);

  async function issue(input:PeriodInput){
    let payload:ReturnType<typeof reviewRentalPeriod>['payload'];
    try{payload=reviewRentalPeriod(booking,input,periods).payload;}
    catch(failure){setError((failure as Error).message);return;}
    if(period.contractualEnd&&(input.startsOn<period.contractualStart||input.endsOn>period.contractualEnd)){
      setError('Las fechas del período deben quedar dentro del período acordado del alquiler.');return;}
    // The same body keeps the same key: a retry never documents the period twice.
    const next=rentalIssueAttempt(attempt.current,rentalIssueBody('period',payload),()=>crypto.randomUUID());
    attempt.current=next;
    setBusy(true);setError('');
    try{
      await reservationCommand('period',payload,next.key);
      attempt.current=null;
      await onChange?.();
      toast('Importe a cobrar emitido.');
      onClose();
    }catch(failure){setError((failure as Error).message);}
    finally{setBusy(false);}
  }

  const ready=!loading&&!loadError&&!!period.startsOn&&!!period.endsOn;
  return <DialogContent className={styles.dialog}>
    <DialogTitle className="text-lg font-semibold">{rentalIssueTitle}</DialogTitle>
    <DialogDescription className="field-hint mt-2">{rentalIssueConsequence}</DialogDescription>
    <div className={styles.body}>
      {loading&&<p className="field-hint">Consultando los datos acordados del período…</p>}
      {!!loadError&&<p role="alert" className="form-error">{loadError}</p>}
      {!loading&&!loadError&&!ready&&<p className="field-hint">{rentalIssueEmptyPeriod}</p>}
      {ready&&<RentalIssueForm facts={facts} prefill={prefill} busy={busy} error={error} onIssue={issue}/>}
    </div>
  </DialogContent>;
}

// The form of the modal: the agreed facts are read-only context and only the amount, the
// emission date, the due date and the reason of the period are editable.
export function RentalIssueForm({facts,prefill,busy,error,onIssue}:{
  facts:RentalIssueFacts;prefill:RentalIssuePrefill;busy:boolean;error:string;
  onIssue:(input:PeriodInput)=>void;}){
  const [values,setValues]=useState({startsOn:prefill.startsOn,endsOn:prefill.endsOn,
    amount:prefill.amount,date:prefill.date,dueOn:prefill.dueOn,reason:''});
  return <form onSubmit={event=>{event.preventDefault();
    onIssue({startsOn:values.startsOn,endsOn:values.endsOn,date:values.date,dueOn:values.dueOn,
      amount:values.amount,reason:values.reason});}}>
    <fieldset disabled={busy} className="space-y-4">
      <legend className="sr-only">Confirmación del importe a cobrar del período</legend>
      <section aria-label="Datos ya conocidos del período">
        <p className="field-hint">Estos datos ya están acordados. Solo confirme lo que cambia.</p>
        <dl className={styles.facts}>
          <div><dt>Cliente</dt><dd>{facts.customer||'Sin cliente en la reserva'}</dd></div>
          <div><dt>Vehículo</dt><dd>{facts.vehicle||'Sin vehículo en la reserva'}</dd></div>
          <div><dt>Período acordado</dt><dd>{facts.period.startsOn} al {facts.period.endsOn}</dd></div>
          <div><dt>Días del período</dt><dd>{facts.period.days??'—'}</dd></div>
          <div><dt>Total acordado</dt><dd>{facts.agreedTotal==null?'—':money(facts.agreedTotal)}</dd></div>
          <div><dt>Tarifa diaria</dt><dd>{facts.dailyRate==null?'—':money(facts.dailyRate)}</dd></div>
          <div><dt>Pendiente por cobrar</dt><dd>{money(facts.pending)}</dd></div>
          <div><dt>Pendiente de emitir</dt><dd>{money(facts.pendingToEmit)}</dd></div>
        </dl>
      </section>
      <label className="form-field"><span>Importe del período USD</span>
        <input type="number" min="0.01" step="0.01" name="amount" required value={values.amount}
          onChange={event=>setValues(current=>({...current,amount:event.target.value}))}/></label>
      <p className="field-hint">Total acordado de referencia: {facts.agreedTotal==null?'—':money(facts.agreedTotal)}.
        {facts.pendingToEmit>0?` Queda por emitir ${money(facts.pendingToEmit)}. `:''}
        Puede emitir otro importe si el cliente acordó otro monto para el período.</p>
      <div className="form-grid">
        <label className="form-field"><span>Fecha de emisión del período</span>
          <input type="date" name="date" required value={values.date}
            onChange={event=>setValues(current=>({...current,date:event.target.value}))}/></label>
        <label className="form-field"><span>Vencimiento del período</span>
          <input type="date" name="dueOn" required value={values.dueOn}
            onChange={event=>setValues(current=>({...current,dueOn:event.target.value}))}/></label>
      </div>
      <details className={styles.dates}>
        <summary>{rentalIssueDatesDisclosure}</summary>
        <div className="form-grid mt-3">
          <label className="form-field"><span>Período desde (inclusive)</span>
            <input type="date" name="startsOn" required value={values.startsOn}
              onChange={event=>setValues(current=>({...current,startsOn:event.target.value}))}/></label>
          <label className="form-field"><span>Período hasta (inclusive)</span>
            <input type="date" name="endsOn" required value={values.endsOn}
              onChange={event=>setValues(current=>({...current,endsOn:event.target.value}))}/></label>
        </div>
        <p className="field-hint">Las fechas deben quedar dentro del período acordado del alquiler y
          no se superponen con días ya documentados.</p>
      </details>
      <label className="form-field"><span>Acuerdo del período</span>
        <textarea name="reason" required value={values.reason}
          onChange={event=>setValues(current=>({...current,reason:event.target.value}))}/></label>
      <p className="field-hint">{rentalIssueReasonHint}</p>
      {!!error&&<p role="alert" className="form-error">{error}</p>}
      <Button type="submit" disabled={busy}>{rentalIssueSubmitLabel(values.amount)}</Button>
    </fieldset>
  </form>;
}
