'use client';
import {useEffect,useState,type ReactNode} from 'react';
import Link from 'next/link';
import {Wallet,Receipt,CalendarRange} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {rentalAccounts,rentalAccountsAdvice,rentalAgreementSentence,rentalElapsed,rentalIssuedPendingSentence,rentalMoneyEvidence,rentalPendingSentence,rentalReconciliationAlarm,type RentalAccounts,type ReconciliationAlarm} from '@/controladores/rental-lifecycle';
import {ReceiptDialog} from '@/components/organisms/linked-receipt';
import {RentalIssueModal} from '@/components/organisms/rental-periods';
import {Dialog,DialogTrigger} from '@/components/ui/dialog';
import {operationMoney} from '@/controladores/operation-money';
import {diaryHref} from '@/controladores/linked-money';
import type {CaseFile} from '@/lib/supabase/cases';
import type {Reservation} from '@/lib/supabase/reservations';
import styles from './rental-accounts.module.css';

type Intent='advance';

// The share of a grouped document is a subset of the same balance: it is never a second amount.
function groupedShareSentence(accounts:RentalAccounts,groupedShare:number):string{
  const own=Math.max(0,Math.round((accounts.balance-groupedShare)*100)/100);
  return `Saldo pendiente de los importes ya emitidos al cliente: ${money(accounts.balance)}. `+
    `${money(own)} de importes individuales se cobran desde aquí; ${money(groupedShare)} pertenece a un documento agrupado `+
    `y se asigna por línea en Cobros, no se cobra desde esta sección.`;
}
// A grouped share belongs to a shared document: this section cannot collect it.
function rentalAccountsStatus(accounts:RentalAccounts|null,groupedShare:number,alarm?:ReconciliationAlarm|null):string{
  if(!accounts)return rentalAccountsAdvice(null);
  const grouped=groupedShare>0&&accounts.balance>0;
  // With the reconciliation alarm on screen the status never repeats the same difference: it
  // keeps only what the alarm does not say.
  if(alarm)return grouped?groupedShareSentence(accounts,groupedShare):'';
  if(!grouped)return rentalAccountsAdvice(accounts);
  return `${groupedShareSentence(accounts,groupedShare)} ${rentalAgreementSentence(accounts)}`;
}

export function RentalAccounts({file,booking,onChange,collectionSlot,onOpenExtension}:{
  file:CaseFile;booking:Reservation;onChange:()=>Promise<void>;collectionSlot?:ReactNode;onOpenExtension?:()=>void;
}){
  const {can}=useBusiness();
  const [intent,setIntent]=useState<Intent|null>(null);
  const [issuing,setIssuing]=useState(false);
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(timer);},[]);
  // Money is visible only with the current permission; a cached dialog never survives a revocation.
  const allowed=file.financialAccess&&can('expenses.read');
  const writable=allowed&&can('expenses.write');
  // Issuing an amount to collect keeps the guards of the canonical period path.
  const canIssue=allowed&&booking.status==='Confirmada'&&can('orders.write')&&can('expenses.write');
  useEffect(()=>{if(!allowed)setIntent(null);},[allowed]);
  useEffect(()=>{if(!canIssue)setIssuing(false);},[canIssue]);
  const accounts=rentalAccounts(rentalMoneyEvidence(file,booking,rentalElapsed(booking,now).estimate));
  const documents=file.documents??[];
  const payable=documents.filter(document=>!document.grouped&&Number(document.scope_balance)>0);
  // The grouped share is a subset of the same persisted balance; it is never a second money calculation.
  const groupedShare=documents.filter(document=>document.grouped)
    .reduce((sum,document)=>sum+Number(document.scope_balance),0);
  const advances=(file.advances??[]).filter(payment=>Number(payment.available_amount)>0);
  const revision=documents.map(document=>document.id+':'+document.scope_balance).join('|')+
    (file.advances??[]).map(payment=>payment.id+':'+payment.available_amount).join('|');
  if(!allowed)return <section className="panel p-5" aria-label="Cuentas del alquiler">
    <h2 className="font-semibold">Cuentas de {folio('ALQ',booking.folio_number)}</h2>
    <p className="inline-note mt-4">Información financiera restringida. Se requiere el permiso de lectura de gastos
      para mostrar el importe emitido, el saldo pendiente y el anticipo disponible.</p>
    <p className="field-hint mt-3">Consultar esta sección no emite importes a cobrar ni registra cobros.</p>
  </section>;
  const pending=accounts?accounts.pending:0;
  // The reconciliation alarm: what was agreed against what was already issued. It only informs
  // the operator: it never disables an action and it never issues anything.
  const alarm=rentalReconciliationAlarm(accounts);
  const status=rentalAccountsStatus(accounts,groupedShare,alarm);
  return <section className="panel p-5" aria-label="Cuentas del alquiler">
    <h2 className="font-semibold">Cuentas de {folio('ALQ',booking.folio_number)}</h2>
    <p className="inline-note mt-4">Tres cifras bastan para seguir el alquiler: lo acordado, lo cobrado y lo que falta
      por cobrar. El detalle de los importes queda a un clic, debajo.</p>
    <section aria-label="Resumen de cuentas">
      <dl className={styles.facts}>
        <div><dt>Lo acordado</dt>
          <dd>{accounts?.agreed==null?'Sin total acordado':money(accounts.agreed)}</dd>
          <small>Es lo pactado en el contrato. El documento de cobro de ese importe es lo que deja el saldo pendiente registrado.</small></div>
        <div><dt>Lo cobrado</dt>
          <dd>{money(accounts?.paid??0)}</dd>
          <small>Dinero ya recibido y aplicado a los importes emitidos de este alquiler. Un anticipo sin aplicar todavía no cuenta aquí.</small></div>
        <div className={pending>0?styles.pending:''}><dt>Lo pendiente</dt>
          <dd>{money(pending)}</dd>
          <small>{accounts?(alarm?rentalIssuedPendingSentence(accounts):rentalPendingSentence(accounts)):
            'Información financiera restringida: no hay importes que mostrar.'}</small></div>
      </dl>
      {alarm&&<p className={styles.alarm} data-testid="reconciliation-alarm">{alarm.text}</p>}
    </section>
    {status&&<p className={styles.status} role="status">{status}</p>}
    {(groupedShare>0||accounts&&accounts.pendingIssued>0)&&
      <p className="field-hint">
        {groupedShare>0&&<span>Parte de un documento agrupado: <strong>{money(groupedShare)}</strong>. Ese importe pertenece a un documento compartido y se asigna por línea en <Link href="/cobros">Cobros</Link>; esta sección no lo cobra. </span>}
        {accounts&&accounts.pendingIssued>0&&<span>Cerrar el folio no cancela el saldo pendiente; se cobra por separado.</span>}
      </p>}
    <details className={styles.detail}>
      <summary>Detalle de importes</summary>
      <RentalBillingDetail file={file}/>
    </details>
    <div className={styles.actions}>
      <p className="field-hint">Tres acciones mueven el dinero de este alquiler: <strong>emitir</strong> documenta lo que el
        cliente debe, <strong>cobrar</strong> registra el dinero recibido y <strong>aplicar un anticipo</strong> usa dinero ya
        recibido. Emitir no registra cobros y ninguna de las tres cancela el acuerdo ni vuelve a sumar el mismo dinero.</p>
      <section className={`${styles.action} ${styles.actionPrimary}`} aria-label="Emitir importe a cobrar">
        <h3><CalendarRange size={16}/>Emitir importe a cobrar</h3>
        {canIssue?<Dialog open={issuing} onOpenChange={setIssuing}>
          <DialogTrigger asChild><Button>Emitir importe a cobrar</Button></DialogTrigger>
          <RentalIssueModal open={issuing} booking={booking} vehicle={file.vehicle}
            agreed={accounts?accounts.agreed:null} pending={pending}
            pendingToEmit={accounts?accounts.pendingToEmit:0} onChange={onChange}
            onClose={()=>setIssuing(false)}/>
        </Dialog>:
          <p className="inline-note">Emitir un importe a cobrar requiere un alquiler confirmado y los permisos de
            escritura de órdenes y de gastos.</p>}
        {onOpenExtension&&<div className="field-hint">
          <p>Si lo que necesita es ampliar la fecha de devolución, use la extensión del alquiler en la etapa Alquilado.</p>
          <Button variant="outline" onClick={onOpenExtension}>Ir a la extensión del alquiler</Button></div>}
      </section>
      {collectionSlot&&<section className={styles.action} aria-label="Cobrar saldo pendiente">
        <h3><Wallet size={16}/>Realizar cobro</h3>
        {collectionSlot}
      </section>}
      <section className={styles.action} aria-label="Usar anticipo disponible">
        <h3><Receipt size={16}/>Usar anticipo disponible</h3>
        {writable&&advances.length>0?<Button variant="outline" onClick={()=>setIntent('advance')}>Usar anticipo disponible</Button>:
          <p className="inline-note">{advances.length?'Aplicar anticipos requiere permiso de escritura de gastos.':
            'No hay anticipos disponibles en este alquiler.'}</p>}
      </section>
    </div>
    {intent&&<ReceiptDialog customerId={booking.customer_id} reservationId={booking.id}
      documentId={payable.length===1?payable[0].id:undefined}
      revision={revision} onChange={onChange} onClose={()=>setIntent(null)}
      workshopContext={{mode:'existing',documents:payable.map(document=>({id:document.id,balance:Number(document.scope_balance)})),
        advanceIds:advances.map(payment=>payment.id)}}/>}
  </section>;
}

// The technical detail of the billing: what was issued, what was applied and what is still open.
// It never invents an amount; every row comes from the persisted scope of the folio.
export function RentalBillingDetail({file}:{file:CaseFile}){
  const booking=file.reservations[0];const amount=operationMoney(file);
  return <section aria-label="Importes documentados del alquiler">
    <dl className="detail-list">
      <div><dt>Importes emitidos al cliente</dt><dd>{money(amount.charged)}</dd></div>
      <div><dt>Cobros aplicados (netos)</dt><dd>{money(amount.paid)}</dd></div>
      <div><dt>Saldo pendiente del documento de cobro</dt><dd>{money(amount.balance)}</dd></div>
      <div><dt>Anticipos por aplicar</dt><dd>{money(amount.advances)}</dd></div>
    </dl>
    {(file.documents??[]).map(document=><article className="inline-note mt-3" key={document.id}>
      <strong>{folio('CAR',document.folio_number)} · {document.description}</strong>
      <p>{document.issued_on} / {document.due_on} · Importe emitido de este alquiler: {money(document.scope_amount)} · Saldo: {money(document.scope_balance)}</p>
      {document.grouped&&<Link className="text-link" href={`/cobros/?operacion=${encodeURIComponent(booking.id)}`}>Documento agrupado: repartir recibos y ajustes por línea en Cobros →</Link>}
    </article>)}
    {(file.advances??[]).map(payment=><p className="inline-note mt-3" key={payment.id}>
      {folio('REC',payment.folio_number)} · Anticipo disponible: {money(payment.available_amount)} · {payment.reference}
      <br/><Link className="text-link" href={diaryHref(booking.id,'receipt:'+payment.id,payment.paid_on)}>Ver recibo original en diario →</Link>
    </p>)}
    <h3 className="font-semibold mt-4">Cobros aplicados</h3>
    {(file.applications??[]).map(application=><p className="inline-note mt-3" key={application.id}>
      {application.effective_on} · {application.kind} · {money(application.scope_amount)} · {application.reason}
      <br/><Link className="text-link" href={diaryHref(booking.id,'receipt:'+application.payment_id,
        file.payments?.find(payment=>payment.id===application.payment_id)?.paid_on)}>Ver recibo en diario →</Link>
    </p>)}
    <p className="inline-note mt-4">Los importes ya emitidos no se sustituyen por una estimación ni se recalculan al devolver antes.
      <Link className="text-link" href="/cobros/"> Revisar notas de crédito, aplicaciones o devoluciones en Cobros →</Link></p>
  </section>;
}
