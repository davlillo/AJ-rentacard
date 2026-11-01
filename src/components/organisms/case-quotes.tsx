'use client';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {useCaseAction} from '@/hooks/use-case-action';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {estimateCommand} from '@/lib/supabase/estimates';
import type {CaseFile,CaseOrder} from '@/lib/supabase/cases';
import {AdaptiveTable} from './adaptive-table';

export function CaseQuotes({file,job,onChange}:{file:CaseFile;job:CaseOrder;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const quotes=(file.quotes??[]).filter(q=>q.order_id===job.id).sort((a,b)=>b.revision-a.revision);
  const latest=quotes[0];
  return <section aria-label={`Presupuestos de ${folio('OT',job.id)}`}>
    <div className="quote-list-tools"><div><h2 className="font-semibold">Presupuestos del trabajo</h2><p className="field-hint mt-2">Cada versión contiene el alcance completo. Las versiones anteriores no se suman al total.</p></div>
      <Button variant="outline" asChild><Link href={latest?`/presupuestos/?id=${latest.id}`:`/presupuestos/?trabajo=${encodeURIComponent(job.id)}`}>{latest?'Ver y editar presupuesto':'Preparar presupuesto'}</Link></Button></div>
    {quotes.map(quote=><details key={quote.id} className="panel p-5 mt-5" open={quote.id===latest?.id}>
      <summary><span className="folio-link">{folio('PRE',quote.folio_number)}</span> · Versión {quote.revision} · {quote.status} · {job.internal_job?(quote.snapshot.costComplete===false?'Costo por completar':money(quote.snapshot.cost)):money(quote.snapshot.total)}</summary>
      <div className="table-scroll mt-4"><AdaptiveTable><thead><tr><th>Partida</th><th>Cantidad</th><th>{job.internal_job?'Costo previsto':'Precio'}</th><th>Costo previsto</th><th>Costo real asignado</th></tr></thead>
        <tbody>{quote.snapshot.lines.map((line,index)=><tr key={index}><td>{line.description}</td><td>{line.quantity}</td>
          <td>{job.internal_job?(line.cost===null?'Por definir':money(line.cost)):money(line.price)}</td><td>{line.cost===null?'Por definir':money(line.cost)}</td>
          <td>{money((file.allocations??[]).filter(a=>a.estimate_id===quote.id&&a.line_index===index).reduce((sum,a)=>sum+Number(a.amount),0))}</td></tr>)}</tbody></AdaptiveTable></div>
      <p className="mt-4 text-sm">{quote.reason}</p>
      {can('expenses.write')&&quote.id===latest?.id&&quote.status==='Borrador'&&job.status!=='Entregado'&&<details className="mt-5"><summary>Registrar aprobación o rechazo</summary><form className="operation-form" onSubmit={event=>{
        event.preventDefault();const f=new FormData(event.currentTarget);const command=String(f.get('decision')) as 'approve'|'reject';
        const payload={estimateId:quote.id,approverName:String(f.get('approverName')),evidence:String(f.get('evidence'))};
        void execute(command,payload,key=>estimateCommand(command,payload,key));
      }}><label className="form-field"><span>Persona que decide el alcance</span><input name="approverName" required/></label>
        <label className="form-field"><span>Evidencia de aceptación o rechazo</span><textarea name="evidence" required/></label>
        <label className="form-field"><span>Decisión del presupuesto</span><select aria-label="Decisión del presupuesto" name="decision"><option value="approve">Aprobar alcance</option><option value="reject">Rechazar alcance</option></select></label>
        <Button type="submit" disabled={busy}>Guardar decisión</Button></form></details>}
    </details>)}{!quotes.length&&<p className="module-empty">Todavía no hay un presupuesto para este trabajo.</p>}
    {error&&<p role="alert" className="form-error mt-4">{error}</p>}
  </section>;
}
