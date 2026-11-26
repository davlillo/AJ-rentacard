'use client';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {estimateCommand} from '@/lib/supabase/estimates';
import {clarityLabels} from '@/controladores/budget-clarity';
import {additionalLineIndexes,budgetAdditionalItems,budgetDraftTotals,type DraftKindTotals} from '@/controladores/budget-draft';
import {useState} from 'react';
import type {CaseFile,CaseOrder} from '@/lib/supabase/cases';
import {AdaptiveTable} from './adaptive-table';
import styles from './case-quotes.module.css';
import {Disclosure} from '@/components/organisms/disclosure';

// Plain labels for the money split. A kind that is zero prints no row at all.
const kindRows=(kinds:DraftKindTotals)=>[
  {label:'Repuestos (material)',amount:kinds.material},
  {label:'Mano de obra',amount:kinds.labor},
  {label:'Servicios externos',amount:kinds.thirdParty},
  {label:'Otros costos',amount:kinds.indirect},
].filter(row=>row.amount!==0);
const revisionState=(status:string)=>status==='Aprobado'?'aprobado':status==='Rechazado'?'rechazado':'pendiente de aprobación';
const snapshotLine=(line:{description:string;quantity:number;unitPrice:number;unitCost:number|null})=>
  ({description:line.description,quantity:Number(line.quantity),unitPrice:Number(line.unitPrice),unitCost:line.unitCost===null?null:Number(line.unitCost)});

export function CaseQuotes({file,job,onChange}:{file:CaseFile;job:CaseOrder;onChange:()=>Promise<void>}){
   const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
   const [imageBusy,setImageBusy]=useState(false);const [imageError,setImageError]=useState('');
  const quotes=(file.quotes??[]).filter(q=>q.order_id===job.id).sort((a,b)=>b.revision-a.revision);
  const latest=quotes[0];
  // The approved scope is the only chargeable amount. The issuance itself is a
  // prominent card of the stage template, so the operator sees it before the
  // quote tables instead of hunting for it at the bottom of this list.
  // Additional items and the labor/material split are read from the saved versions and
  // costs of this work only; no extra total is computed here.
  const additional=budgetAdditionalItems(quotes.map(quote=>({id:quote.id,revision:quote.revision,
    parent_id:quote.parent_id,status:quote.status,snapshot:{lines:quote.snapshot.lines.map(snapshotLine)}})),
    (file.costs??[]).filter(cost=>cost.order_id===job.id).map(cost=>({id:cost.id,description:cost.description,
      amount:cost.amount,disposition:cost.disposition,estimate_id:cost.estimate_id})));
  const addedIndexes=(quote:{parent_id:string|null;snapshot:{lines:{description:string;quantity:number;unitPrice:number;unitCost:number|null}[]}})=>{
    const parent=quotes.find(version=>version.id===quote.parent_id);
    return new Set(additionalLineIndexes(quote.snapshot.lines.map(snapshotLine),(parent?.snapshot.lines??[]).map(snapshotLine)));
  };
  const totalsFor=(quote:{snapshot:{lines:{kind:string;quantity:number;unitPrice:number;unitCost:number|null}[];discount:number}})=>
    budgetDraftTotals(quote.snapshot.lines.map(line=>({kind:line.kind,quantity:String(line.quantity),
      unitPrice:String(line.unitPrice),unitCost:line.unitCost===null?'':String(line.unitCost)})),String(quote.snapshot.discount));
   if(!file.financialAccess||!can('expenses.read'))return <p className="inline-note">Información financiera restringida.</p>;
   return <section className="workshop-quotes" aria-label={`Presupuestos de ${folio('OT',job.id)}`}>
    <div className="quote-list-tools"><div><h2 className="font-semibold">Presupuestos del trabajo</h2><p className="field-hint mt-2">Cada versión contiene el alcance completo. Las versiones anteriores no se suman al total.</p></div>
       <Button variant="outline" asChild><Link href={latest?`/presupuestos/?id=${latest.id}`:`/presupuestos/?trabajo=${encodeURIComponent(job.id)}`}>{latest?'Ver costos previstos y editar presupuesto':'Estimar costos y preparar presupuesto'}</Link></Button>
       {latest&&!job.internal_job&&<Button variant="outline" asChild><Link href={`/presupuestos/?id=${latest.id}&adicional=1`}>Agregar adicional al cliente</Link></Button>}</div>
    {quotes.map(quote=>{const added=addedIndexes(quote);const totals=totalsFor(quote);return <Disclosure key={quote.id} className="panel p-5 mt-5" defaultOpen={quote.id===latest?.id}
      label={<><span className="folio-link">{folio('PRE',quote.folio_number)}</span> · Versión {quote.revision} · {quote.status} · {job.internal_job?(quote.snapshot.costComplete===false?clarityLabels.missingCost:money(quote.snapshot.cost)):money(quote.snapshot.total)}</>}>
      <div className="table-scroll mt-4"><AdaptiveTable><thead><tr><th>Partida</th><th>Cantidad</th><th>{job.internal_job?'Costo interno':'Precio'}</th><th>{clarityLabels.internalCost} (interno)</th><th>Costo real asignado (interno)</th></tr></thead>
        <tbody>{quote.snapshot.lines.map((line,index)=><tr key={index}><td>{line.description}{added.has(index)&&<> <Badge tone="amber">Adicional</Badge></>}</td><td>{line.quantity}</td>
          <td>{job.internal_job?(line.cost===null?clarityLabels.missingCost:money(line.cost)):money(line.price)}</td><td>{line.cost===null?clarityLabels.missingCost:money(line.cost)}</td>
          <td>{money((file.allocations??[]).filter(a=>a.estimate_id===quote.id&&a.line_index===index).reduce((sum,a)=>sum+Number(a.amount),0))}</td></tr>)}</tbody></AdaptiveTable></div>
       <div className="budget-tally">{!job.internal_job&&<><div><span>Subtotal</span><strong>{money(quote.snapshot.subtotal)}</strong></div>
         {kindRows(totals.priceByKind).map(row=><div key={row.label} className={styles.kindRow}><span>{row.label}</span><strong>{money(row.amount)}</strong></div>)}
         <div><span>Descuento</span><strong>{money(quote.snapshot.discount)}</strong></div></>}
         {job.internal_job&&kindRows(totals.costByKind).map(row=><div key={row.label} className={styles.kindRow}><span>{row.label}</span><strong>{money(row.amount)}</strong></div>)}
         <div className="grand-total"><span>{job.internal_job?clarityLabels.internalCost:'Total'}</span><strong>{job.internal_job?(quote.snapshot.costComplete===false?clarityLabels.missingCost:money(quote.snapshot.cost)):money(quote.snapshot.total)}</strong></div></div>
       <p className="mt-4 text-sm">{quote.reason}</p>
       {!job.internal_job&&<div className="mt-4"><Button variant="outline" disabled={imageBusy} onClick={()=>{
         setImageBusy(true);setImageError('');
         void Promise.all([import('@/lib/documents/pdf'),import('@/lib/documents/quote-image')]).then(async([pdf,image])=>{
           await image.downloadQuoteImages(pdf.quoteDocumentContent(quote),`${folio('PRE',quote.folio_number)}-V${quote.revision}`);
         }).catch(error=>setImageError(error.message)).finally(()=>setImageBusy(false));
       }}>{imageBusy?'Preparando imagen…':'Descargar imagen para el cliente'}</Button>
         <p className="field-hint mt-2">La imagen para el cliente incluye solo información del cliente y precios de esta versión; no incluye costos internos ni margen. La descarga no registra envío ni aprobación.</p>
       </div>}
      {can('expenses.write')&&quote.id===latest?.id&&quote.status==='Borrador'&&job.status!=='Entregado'&&<Disclosure className="mt-5" label="Registrar aprobación o rechazo"><form className="operation-form" onSubmit={event=>{
        event.preventDefault();const f=new FormData(event.currentTarget);const command=String(f.get('decision')) as 'approve'|'reject';
        const payload={estimateId:quote.id,approverName:String(f.get('approverName')),evidence:String(f.get('evidence'))};
        void execute(command,payload,key=>estimateCommand(command,payload,key));
      }}><label className="form-field"><span>{clarityLabels.approver}</span><input name="approverName" required/></label>
        <label className="form-field"><span>{clarityLabels.evidence}</span><textarea name="evidence" required/></label>
        <label className="form-field"><span>Decisión del presupuesto</span><select aria-label="Decisión del presupuesto" name="decision"><option value="approve">Aprobar alcance</option><option value="reject">Rechazar alcance</option></select></label>
        <Button type="submit" disabled={busy}>Guardar decisión</Button></form></Disclosure>}
    </Disclosure>;})}{!quotes.length&&<p className="module-empty">Todavía no hay un presupuesto para este trabajo.</p>}
     {!job.internal_job&&(additional.lines.length>0||additional.outside.length>0)&&<section className={styles.additionalBlock} aria-label="Adicionales del trabajo">
       <h3>Adicionales</h3>
       <p className="field-hint">Partidas agregadas después del alcance inicial. Solo cuentan cuando su versión queda aprobada.</p>
       {!!additional.lines.length&&<ul className={styles.additionalList}>{additional.lines.map((item,index)=>
         <li key={item.quoteId+'-'+index}><span>{item.description}</span><span className={styles.additionalAmount}>{money(item.amount)}</span>
           <small>Versión {item.revision} · {revisionState(item.status)}</small></li>)}</ul>}
       {additional.outside.map(cost=><p key={cost.costId} className={styles.outsideAdditional}>
         <strong>Adicional autorizado fuera del presupuesto:</strong> {cost.description} · {money(cost.amount)}.
         <span>No está incluido en el alcance aprobado; requiere una versión aprobada antes de cobrarse.</span></p>)}
     </section>}
     {(error||imageError)&&<p role="alert" className="form-error mt-4">{error||imageError}</p>}
  </section>;
}
