'use client';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {diaryHref} from '@/controladores/linked-money';
import {orderHref,type CaseFile} from '@/lib/supabase/cases';
import type {WorkshopCost} from '@/lib/supabase/workshop';
import styles from './money-workspace.module.css';

export function BudgetCostOrigins({file,orderId,onAdd,selected=[]}:{file:CaseFile;orderId:string;onAdd?:(cost:WorkshopCost)=>void;selected?:string[]}){
  return <section className={styles.inbox} aria-label="Costos ya registrados del trabajo">
    <header><div><h3>Costos ya registrados de este trabajo</h3><p>Vienen del mismo folio y diario. Incorporar una partida no crea otra compra ni otro pago.
      El precio al cliente se define por separado.</p></div><Link className={styles.sourceLink} href={orderHref(orderId)+'&seccion=Costos'}>Ver folio →</Link></header>
    {!file.costs?.length?<p>Todavía no hay costos reales asociados. Puede registrar un gasto desde el diario o desde el folio.</p>:
      <div className={styles.inboxList}>{file.costs.map(cost=>{const source=cost.expense_id??cost.linked_expense_id;
        const bound=file.allocations?.some(a=>a.cost_id===cost.id);const picked=selected.includes(cost.id);
        return <div key={cost.id}><div><strong>{cost.description}</strong><small>{cost.occurred_at} · {cost.disposition==='Pendiente'?'Por revisar':cost.disposition}</small>
          {source&&<Link className={styles.sourceLink} href={diaryHref(orderId,'expense:'+source,cost.occurred_at)}>{source} · Ver gasto original →</Link>}
          {bound&&<small>Ya tiene vínculo con partidas del presupuesto. Revise su desglose en el folio.</small>}</div>
          <span>{money(cost.amount)}</span>{onAdd&&<Button type="button" variant="outline" disabled={bound||picked} onClick={()=>onAdd(cost)}>
            {picked?'Incorporado a esta revisión':bound?'Ya vinculado':'Incorporar al presupuesto'}</Button>}</div>;
      })}</div>}
  </section>;
}
