'use client';
import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {readRows} from '@/lib/supabase/business';
import {rentalRpc,reservationCommand,type Reservation} from '@/lib/supabase/reservations';
import {loadBilling,localToday,type Receivable} from '@/lib/supabase/billing';
import {money} from '@/controladores/finanzas';

interface RentalPeriod {id:string;reservation_id:string;starts_on:string;ends_on:string;document_id:string;reason:string;}
export function RentalPeriods({booking}:{booking:Reservation}){
  const {can}=useBusiness();const [periods,setPeriods]=useState<RentalPeriod[]>([]);
  const [documents,setDocuments]=useState<Receivable[]>([]);const [paidThrough,setPaidThrough]=useState<string|null>(null);
  const [loadError,setLoadError]=useState('');
  const reload=useCallback(async()=>{
    setPaidThrough(await rentalRpc('rental_paid_through',{reservation_id:booking.id}));
    if(can('expenses.read')){
      const periods=(await readRows<RentalPeriod>('rental_periods','*')).filter(p=>p.reservation_id===booking.id);
      setPeriods(periods);
      setDocuments((await loadBilling(localToday())).documents.filter(d=>d.reservation_id===booking.id||periods.some(p=>p.document_id===d.id)));
    }
  },[booking.id,can('expenses.read')]);
  const {busy,error,execute}=useCaseAction(reload);
  useEffect(()=>{void reload().catch(error=>setLoadError(error.message));},[reload]);
  return <section className="mt-5"><h3 className="font-semibold">Períodos documentados y pagado hasta</h3>
    <p className="inline-note mt-3">Pagado hasta: <strong>{paidThrough??'Sin cobertura conciliada'}</strong>.
      Se calcula con períodos continuos y documentos saldados. Una nota «cancelado hasta» no cancela el alquiler ni registra dinero.</p>
    {periods.map(period=>{const doc=documents.find(d=>d.id===period.document_id);return <p className="mt-3" key={period.id}>
      {period.starts_on} al {period.ends_on} · {doc?.grouped?'Documento agrupado: consultar el desglose de este alquiler':doc?`${money(doc.amount)} · Saldo ${money(doc.balance)}`:'Documento por consultar'} · {period.reason}</p>;})}
    {booking.status==='Confirmada'&&can('expenses.write')&&<details className="mt-4"><summary>Documentar otro período de alquiler</summary>
      <form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
        const payload={reservationId:booking.id,...Object.fromEntries(['startsOn','endsOn','date','dueOn','amount','reason'].map(key=>[key,String(f.get(key)??'')]))};
        void execute('period',payload,key=>reservationCommand('period',payload,key)).then(saved=>{if(saved)form.reset();});
      }}><div className="form-grid"><label className="form-field"><span>Período desde (inclusive)</span><input type="date" name="startsOn" required/></label>
        <label className="form-field"><span>Período hasta (inclusive)</span><input type="date" name="endsOn" required/></label></div>
        <label className="form-field"><span>Importe acordado del período USD</span><input type="number" min="0.01" step="0.01" name="amount" required/></label>
        <div className="form-grid"><label className="form-field"><span>Fecha de emisión del período</span><input type="date" name="date" required defaultValue={localToday()}/></label>
          <label className="form-field"><span>Vencimiento del período</span><input type="date" name="dueOn" required defaultValue={localToday()}/></label></div>
        <label className="form-field"><span>Acuerdo del período</span><textarea name="reason" required/></label>
        <Button type="submit" disabled={busy}>Emitir cargo del período (no registra cobro)</Button>
      </form></details>}
    {can('expenses.read')&&<p className="mt-4"><Link href="/cobros">Consultar o aplicar recibos en Cargos y cobros</Link></p>}
    {(error||loadError)&&<p role="alert" className="form-error mt-4">{error||loadError}</p>}
  </section>;
}
