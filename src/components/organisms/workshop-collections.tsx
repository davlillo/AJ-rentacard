'use client';
import {useRef,useState} from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import type {CaseFile,CaseOrder} from '@/lib/supabase/cases';
import {localToday} from '@/lib/supabase/billing';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {diaryHref} from '@/controladores/linked-money';
import {workshopCollections,workshopReconciliationAlarm} from '@/controladores/workshop-collections';
import {supplierCredit} from '@/controladores/workshop-cost-entry';
import {workshopAmountText,workshopCollectionState,workshopMoneyLabels,workshopReceivableOverview} from '@/controladores/workshop-money-language';
import {ReceiptForm} from './linked-receipt';
import {WorkshopCosts} from './workshop-costs';
import styles from './workshop-collections.module.css';

type Props={file:CaseFile;job?:CaseOrder;onChange:()=>Promise<void>};
export function WorkshopCollections(props:Props){
  const {can}=useBusiness();
  // Unmount the entire private workspace synchronously, including forms and cached receipt history.
  if(!props.file.financialAccess||!can('expenses.read'))return <p className="inline-note">Información financiera restringida.</p>;
  return <CollectionsWorkspace {...props}/>;
}

function CollectionsWorkspace({file,job,onChange}:Props){
  const {can,data}=useBusiness();
  const summary=workshopCollections(file,job?.id);
  // Plain wording over the canonical facts: the approved scope, what was invoiced, what
  // was collected and what is still pending. Nothing is issued, approved or settled here.
  const overview=workshopReceivableOverview(summary);
  // The reconciliation alarm: the approved scope against what was already issued to the customer.
  // It only informs and it takes the place of the line that explained the same difference.
  const alarm=workshopReconciliationAlarm(summary);
  // Supplier credit of this job, kept apart from the customer receivable.
  const credit=supplierCredit(file.costs,file.expenses,job?.id);
  // The shop money is the counterpart of the customer money: what was already paid
  // to the suppliers and what is still owed to them, both in cents in the source.
  const paidToSupplier=credit.lines.reduce((sum,line)=>sum+line.paid,0);
  const pendingWithSupplier=credit.lines.reduce((sum,line)=>sum+Math.max(line.pending,0),0);
  const [editor,setEditor]=useState<'new'|'existing'|'issue'>();
  const [receiptBusy,setReceiptBusy]=useState(false);
  const editorRef=useRef<HTMLDivElement>(null);
  const {busy,error,execute}=useCaseAction(onChange);
  const inconsistent=!!job&&!job.internal_job&&file.vehicle.ownership==='Propio';
  const writable=can('expenses.write')&&!!job?.customer_id&&!job.internal_job;
  const canIssue=writable&&!inconsistent&&summary.known&&summary.unbilled>0;
  const documents=file.documents??[];
  const individual=documents.filter(document=>!document.grouped&&Number(document.scope_balance)>0);
  const advances=(file.advances??[]).filter(payment=>Number(payment.available_amount)>0);
  const customer=data.customers.find(customer=>customer.id===job?.customer_id);
  function open(next:'new'|'existing'|'issue'){setEditor(next);
    requestAnimationFrame(()=>editorRef.current?.focus());
  }
  if(job?.internal_job)return <p className="inline-note">{workshopMoneyLabels.internalNote}</p>;
  return <section className={styles.workspace} aria-label="Cobros del trabajo">
    <header className={styles.heading}>
      <div><p className={styles.eyebrow}>Estado de cobro</p><h3>{job?.service??'Este trabajo'}</h3>
        <p>{customer?.name??'Cliente del trabajo'} · {job?.id}</p></div>
      <span className={styles.status}>{summary.known?workshopCollectionState(summary.collectionState):'Saldo sin confirmar'}</span>
    </header>
    {!summary.known?<div role="status" className={styles.notice}>
      No se pudo confirmar el estado financiero. Actualice antes de registrar movimientos.
      <Button variant="outline" onClick={()=>{void onChange();}}>Actualizar estado</Button>
      {documents.some(document=>document.grouped)&&<p>Documento compartido con otros trabajos. El saldo de este trabajo no está desglosado.
        {' '}<Link href="/cobros">Ver documento y registrar cobro en Cobros →</Link></p>}
    </div>:<>
      <section className={styles.receivable} aria-label={workshopMoneyLabels.receivableHeading}>
        <h4>{workshopMoneyLabels.receivableHeading}</h4>
        <p className={styles.groupNote}>{workshopMoneyLabels.receivableNote}</p>
        <section className={styles.agreed} aria-label={workshopMoneyLabels.agreedHeading}>
          <h5>{overview.agreed.label}</h5>
          <p className={styles.agreedValue}>{workshopAmountText(overview.agreed,money)}</p>
          <p>{overview.agreed.note}</p>
          <p className={styles.additional}>{overview.additionalNote}</p>
        </section>
        <dl className={styles.summary} aria-label="Resumen de cobros">
          <div className={styles.pending}><dt>{overview.pending.label}</dt><dd>{money(overview.pending.value)}</dd><small>{overview.pending.note}</small></div>
          <div><dt>{overview.issued.label}</dt><dd>{money(overview.issued.value)}</dd><small>{overview.issued.note}</small></div>
          <div><dt>{overview.collected.label}</dt><dd>{money(overview.collected.value)}</dd><small>{overview.collected.note}</small></div>
          <div><dt>{overview.advance.label}</dt><dd>{money(overview.advance.value)}</dd><small>{overview.advance.note}</small></div>
        </dl>
        {alarm?<p className={styles.alarm} data-testid="reconciliation-alarm">{alarm.text}</p>:
          !overview.notInvoiced.available&&<p className={styles.agreement}>{overview.notInvoiced.label}: <strong>{workshopAmountText(overview.notInvoiced,money)}</strong>
            <span>{overview.notInvoiced.note}</span></p>}
        {inconsistent&&<p className={styles.notice}>El vehículo figura como propio de AJ, pero el trabajo tiene cliente. Revise el tipo de ingreso antes de emitir importes a cobrar. No se ha reclasificado el expediente.</p>}
        {writable&&(!inconsistent||documents.length>0)&&<div className={styles.actions}>
          <Button disabled={busy||receiptBusy} onClick={()=>open('new')}>{individual.length?'Registrar cobro':'Registrar anticipo'}</Button>
          {advances.length>0&&individual.length>0&&<Button variant="outline" disabled={busy||receiptBusy} onClick={()=>open('existing')}>Usar anticipo disponible</Button>}
          {canIssue&&<Button variant="outline" disabled={busy||receiptBusy} onClick={()=>open('issue')}>{workshopMoneyLabels.prepareAction}</Button>}
        </div>}
      </section>
      {!documents.length&&<p className={styles.notice}>Aún no hay importe facturado al cliente para este trabajo. Un anticipo registra dinero recibido sin inventar deuda.</p>}
      {editor&&writable&&<div ref={editorRef} tabIndex={-1} className={styles.editor}>
        <div className={styles.editorHeading}><h4>{editor==='issue'?workshopMoneyLabels.prepareAction:editor==='existing'?'Usar anticipo disponible':'Registrar dinero recibido'}</h4>
          <Button variant="outline" disabled={busy||receiptBusy} onClick={()=>setEditor(undefined)}>Cerrar editor</Button></div>
        {editor==='issue'?<WorkshopIssueForm file={file} job={job!} onChange={onChange} onIssued={()=>setEditor(undefined)}/>
          :<ReceiptForm key={editor} customerId={job!.customer_id!} orderId={job!.id}
          onChange={onChange} onSaved={()=>setEditor(undefined)} onBusyChange={setReceiptBusy} revision={summary.revision}
          workshopContext={{mode:editor,documents:individual.map(document=>({id:document.id,balance:Number(document.scope_balance)})),advanceIds:advances.map(payment=>payment.id)}}
          presentation="embedded"/>}
      </div>}
      <section className={styles.costs} aria-label={workshopMoneyLabels.costsHeading}>
        <h4>{workshopMoneyLabels.costsHeading}</h4>
        <section className={styles.supplier} aria-label={workshopMoneyLabels.pendingWithSupplier}>
          <p className={styles.supplierNote}>{workshopMoneyLabels.costsNote}</p>
          {credit.known&&credit.lines.some(line=>line.pending>0)&&<ul className={styles.supplierList}>
            {credit.lines.filter(line=>line.pending>0).map(line=><li key={line.costId}>
              <strong>{line.description}</strong>
              <span>{line.supplier} · Costo {money(line.amount/100)} · Pagado {money(line.paid/100)} · Pendiente {money(line.pending/100)}</span>
            </li>)}
          </ul>}
        </section>
        <dl className={styles.costsTotals}>
          <div><dt>{workshopMoneyLabels.paidToSupplier}</dt><dd>{money(paidToSupplier/100)}</dd>
            <small>{workshopMoneyLabels.paidToSupplierNote}</small></div>
          <div><dt>{workshopMoneyLabels.pendingWithSupplier}</dt><dd>{credit.known?money(pendingWithSupplier/100):'Sin confirmar'}</dd>
            <small>{workshopMoneyLabels.pendingWithSupplierNote}</small></div>
        </dl>
        <WorkshopCosts orderId={job!.id} file={file} onChange={onChange} actionVariant="outline"/>
      </section>
      <details className={styles.history} open>
        <summary>Documentos y movimientos</summary>
        <div className={styles.historyGrid}>
          <section><h4>Documentos de este trabajo</h4>
            {!documents.length&&<p>No hay importes facturados al cliente.</p>}
            {documents.map(document=><article className={styles.record} key={document.id}>
              <strong>{folio('CAR',document.folio_number)} · {document.description}</strong>
              <p>Emisión {document.issued_on} · Vence {document.due_on}</p>
              <p>Facturado de este trabajo: {money(document.scope_amount)} · Saldo de este trabajo: {money(document.scope_balance)}</p>
              {document.grouped&&<><p className={styles.notice}>Documento compartido con otros trabajos. El cobro requiere reparto por línea; no use el total del documento como deuda de este trabajo.</p>
                <Link href="/cobros">Ver documento y registrar cobro en Cobros →</Link></>}
            </article>)}
          </section>
          <section><h4>Cobros aplicados y anticipos</h4>
            {!(file.applications??[]).length&&!advances.length&&<p>Aún no hay movimientos aplicados.</p>}
            {(file.applications??[]).map(application=><article className={styles.record} key={application.id}>
              <strong>{application.kind==='Aplicacion'?'Cobro aplicado':'Reversión de cobro'} · {money((application.kind==='Aplicacion'?1:-1)*Number(application.scope_amount))}</strong>
              <p>{application.effective_on} · {application.reason}</p>
              <Link href={diaryHref(job?.id,'receipt:'+application.payment_id,file.payments?.find(payment=>payment.id===application.payment_id)?.paid_on)}>Ver recibo original en diario →</Link>
            </article>)}
            {advances.map(payment=><article className={styles.record} key={payment.id}>
              <strong>{folio('REC',payment.folio_number)} · Disponible {money(payment.available_amount)}</strong>
              <p>{payment.paid_on} · {payment.reference}</p><p>Ya recibido. Su aplicación no registra otro ingreso.</p>
              <Link href={diaryHref(job?.id,'receipt:'+payment.id,payment.paid_on)}>Ver anticipo original en diario →</Link>
            </article>)}
          </section>
        </div>
      </details>
    </>}
  </section>;
}

// One issuance form for every stage that offers it: the approval card and the
// collections editor mount this same component, so the bill_scope command, its
// payload, its guards and its idempotency behavior exist exactly once. It only
// records the collection document; it never receives money or changes a cost.
export function WorkshopIssueForm({file,job,onChange,onIssued}:{
  file:CaseFile;job:CaseOrder;onChange:()=>Promise<void>;onIssued?:()=>void;
}){
  const {can}=useBusiness();
  const summary=workshopCollections(file,job.id);
  const inconsistent=file.vehicle.ownership==='Propio';
  const writable=can('expenses.write')&&!!job.customer_id&&!job.internal_job;
  const canIssue=writable&&!inconsistent&&summary.known&&summary.unbilled>0;
  const [intentRevision,setIntentRevision]=useState(summary.revision);
  const stale=intentRevision!==summary.revision;
  const {busy,error,execute}=useCaseAction(onChange);
  return <form className="operation-form" onSubmit={event=>{
    event.preventDefault();if(stale||!canIssue)return;
    const form=new FormData(event.currentTarget);
    void execute('bill_scope',{orderId:job.id,date:String(form.get('date')),dueOn:String(form.get('dueOn'))})
      .then(saved=>{if(saved)onIssued?.();});
  }}>
    <p>Se emitirá un documento de cobro por <strong>{money(summary.unbilled)}</strong>, únicamente por la diferencia del alcance aprobado. No registra dinero recibido ni acredita validez fiscal.</p>
    {stale&&<p role="alert">El alcance o los movimientos cambiaron. Revise el importe actualizado antes de emitir.
      <Button variant="outline" onClick={()=>setIntentRevision(summary.revision)}>Revisé el importe actualizado</Button></p>}
    <div className="form-grid">
      <label className="form-field"><span>Fecha de emisión</span><input type="date" name="date" required defaultValue={localToday()}/></label>
      <label className="form-field"><span>Fecha de vencimiento</span><input type="date" name="dueOn" required defaultValue={localToday()}/></label>
    </div>
    {error&&<p role="alert" className="form-error">{error}</p>}
    <Button type="submit" disabled={busy||stale||!canIssue}>{busy?'Emitiendo…':`${workshopMoneyLabels.issueAction} de ${money(summary.unbilled)}`}</Button>
  </form>;
}
