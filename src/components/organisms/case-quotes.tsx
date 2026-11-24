'use client';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {estimateCommand} from '@/lib/supabase/estimates';
import {clarityLabels} from '@/controladores/budget-clarity';
import {useState} from 'react';
import type {CaseFile,CaseOrder} from '@/lib/supabase/cases';
import {AdaptiveTable} from './adaptive-table';

export function CaseQuotes({file,job,onChange}:{file:CaseFile;job:CaseOrder;onChange:()=>Promise<void>}){
   const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
   const [imageBusy,setImageBusy]=useState(false);const [imageError,setImageError]=useState('');
  const quotes=(file.quotes??[]).filter(q=>q.order_id===job.id).sort((a,b)=>b.revision-a.revision);
  const latest=quotes[0];
  // The approved scope is the only chargeable amount. The issuance itself is a
  // prominent card of the stage template, so the operator sees it before the
  // quote tables instead of hunting for it at the bottom of this list.
   if(!file.financialAccess||!can('expenses.read'))return <p className="inline-note">Información financiera restringida.</p>;
   return <section className="workshop-quotes" aria-label={`Presupuestos de ${folio('OT',job.id)}`}>
    <div className="quote-list-tools"><div><h2 className="font-semibold">Presupuestos del trabajo</h2><p className="field-hint mt-2">Cada versión contiene el alcance completo. Las versiones anteriores no se suman al total.</p></div>
       <Button variant="outline" asChild><Link href={latest?`/presupuestos/?id=${latest.id}`:`/presupuestos/?trabajo=${encodeURIComponent(job.id)}`}>{latest?'Ver costos previstos y editar presupuesto':'Estimar costos y preparar presupuesto'}</Link></Button>
       {latest&&!job.internal_job&&<Button variant="outline" asChild><Link href={`/presupuestos/?id=${latest.id}&adicional=1`}>Agregar adicional al cliente</Link></Button>}</div>
    {quotes.map(quote=><details key={quote.id} className="panel p-5 mt-5" open={quote.id===latest?.id}>
      <summary><span className="folio-link">{folio('PRE',quote.folio_number)}</span> · Versión {quote.revision} · {quote.status} · {job.internal_job?(quote.snapshot.costComplete===false?clarityLabels.missingCost:money(quote.snapshot.cost)):money(quote.snapshot.total)}</summary>
      <div className="table-scroll mt-4"><AdaptiveTable><thead><tr><th>Partida</th><th>Cantidad</th><th>{job.internal_job?'Costo interno':'Precio'}</th><th>{clarityLabels.internalCost} (interno)</th><th>Costo real asignado (interno)</th></tr></thead>
        <tbody>{quote.snapshot.lines.map((line,index)=><tr key={index}><td>{line.description}</td><td>{line.quantity}</td>
          <td>{job.internal_job?(line.cost===null?clarityLabels.missingCost:money(line.cost)):money(line.price)}</td><td>{line.cost===null?clarityLabels.missingCost:money(line.cost)}</td>
          <td>{money((file.allocations??[]).filter(a=>a.estimate_id===quote.id&&a.line_index===index).reduce((sum,a)=>sum+Number(a.amount),0))}</td></tr>)}</tbody></AdaptiveTable></div>
       <p className="mt-4 text-sm">{quote.reason}</p>
       {!job.internal_job&&<div className="mt-4"><Button variant="outline" disabled={imageBusy} onClick={()=>{
         setImageBusy(true);setImageError('');
         void Promise.all([import('@/lib/documents/pdf'),import('@/lib/documents/quote-image')]).then(async([pdf,image])=>{
           await image.downloadQuoteImages(pdf.quoteDocumentContent(quote),`${folio('PRE',quote.folio_number)}-V${quote.revision}`);
         }).catch(error=>setImageError(error.message)).finally(()=>setImageBusy(false));
       }}>{imageBusy?'Preparando imagen…':'Descargar imagen para el cliente'}</Button>
         <p className="field-hint mt-2">La imagen para el cliente incluye solo información del cliente y precios de esta versión; no incluye costos internos ni margen. La descarga no registra envío ni aprobación.</p>
       </div>}
      {can('expenses.write')&&quote.id===latest?.id&&quote.status==='Borrador'&&job.status!=='Entregado'&&<details className="mt-5"><summary>Registrar aprobación o rechazo</summary><form className="operation-form" onSubmit={event=>{
        event.preventDefault();const f=new FormData(event.currentTarget);const command=String(f.get('decision')) as 'approve'|'reject';
        const payload={estimateId:quote.id,approverName:String(f.get('approverName')),evidence:String(f.get('evidence'))};
        void execute(command,payload,key=>estimateCommand(command,payload,key));
      }}><label className="form-field"><span>{clarityLabels.approver}</span><input name="approverName" required/></label>
        <label className="form-field"><span>{clarityLabels.evidence}</span><textarea name="evidence" required/></label>
        <label className="form-field"><span>Decisión del presupuesto</span><select aria-label="Decisión del presupuesto" name="decision"><option value="approve">Aprobar alcance</option><option value="reject">Rechazar alcance</option></select></label>
        <Button type="submit" disabled={busy}>Guardar decisión</Button></form></details>}
    </details>)}{!quotes.length&&<p className="module-empty">Todavía no hay un presupuesto para este trabajo.</p>}
     {(error||imageError)&&<p role="alert" className="form-error mt-4">{error||imageError}</p>}
  </section>;
}
