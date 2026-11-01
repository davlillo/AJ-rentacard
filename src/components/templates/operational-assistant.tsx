'use client';
import {useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {agentCost,proposeExpense,confirmExpense,type CostAnswer,type ExpenseProposal} from '@/lib/supabase/control';
import {localToday} from '@/lib/supabase/billing';
import {money} from '@/controladores/finanzas';

export function OperationalAssistant(){
  const {can,refresh}=useBusiness();const [answer,setAnswer]=useState<CostAnswer|null>(null);const [proposal,setProposal]=useState<ExpenseProposal|null>(null);
  const [folio,setFolio]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const sending=useRef(false);
  const attempt=useRef<{body:string;key:string}|null>(null);
  async function run(action:()=>Promise<void>){if(sending.current)return;sending.current=true;setBusy(true);setError('');try{await action();}catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}}
  return <><PageHeading eyebrow="ASISTENTE OPERATIVO / FUENTES Y CONFIRMACIÓN" title="Asistente de AJ"
    description="Consultas acotadas a datos reales y gastos confirmables. No es un chat general ni requiere enviar datos a un proveedor de IA."/>
    <section className="panel p-5"><h2 className="font-semibold">Consultar costo por vehículo y operación</h2>
      <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{
        const question=String(f.get('question'));const vehicle=question.match(/(?:veh[ií]culo|placa|carro)\s+([a-z0-9-]+)/i)?.[1];
        if(!/(cost|gast|desglose)/i.test(question)||!vehicle)throw new Error('Indique una consulta de costo con vehículo o placa, por ejemplo: ¿Cuánto costó el vehículo P123 en OT-7?');
        const operation=question.match(/\bOT-\d+\b/i)?.[0].toUpperCase()??null;
        setAnswer(await agentCost(vehicle,operation,String(f.get('cutoff'))));
      });}}><label className="form-field"><span>Pregunta operativa</span><textarea name="question" required placeholder="¿Cuánto costó el vehículo P123 en OT-7?"/></label>
        <label className="form-field"><span>Fecha de corte del asistente</span><input name="cutoff" type="date" defaultValue={localToday()} required/></label><Button type="submit" disabled={busy}>Consultar fuentes reales</Button>
      </form>
      {answer&&<article className="inline-note mt-4"><h3 className="font-semibold">{answer.plate} · corte {answer.cutoff}</h3>
        {answer.requiresSelection?<p>Hay varias operaciones. Incluya el folio en la pregunta: {answer.operations?.map(o=>`${o.id} (${o.service})`).join(', ')}</p>:
          <><p>Operación {answer.operationId??'sin costos registrados'} · costo directo {money(answer.total??0)}</p>
            {answer.sources?.map(source=><p key={source.id} className="mt-3">{source.description}: {money(source.amount)}<small>Fuente {source.id} · {source.order_id} · {source.expense_id??'Compra o consumo'}</small></p>)}
            <p className="field-hint">No incluye mano de obra sin valorar ni indirectos no asignados. No se usa el precio presupuestado como costo real.</p></>}
      </article>}
    </section>
    {can('expenses.write')&&<section className="panel p-5 mt-5"><h2 className="font-semibold">Solicitar un gasto, revisar y confirmar</h2>
      <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{
        const text=String(f.get('instruction'));const match=text.match(/gasto\s+(?:de\s+)?\$?(\d+(?:\.\d{1,2})?)\s+en\s+(?:(OT-\d+)|centro\s+([a-z0-9_-]+))\s+por\s+(.+)/i);
        if(!match)throw new Error('Use: gasto de 35.10 en OT-7 por aceite, o gasto de 12 en centro workshop por limpieza.');
        const payload={amount:match[1],operationId:match[2]?.toUpperCase()??null,costCenterId:match[3]??null,concept:match[4].trim(),
          category:String(f.get('category')),account:String(f.get('account')),method:String(f.get('method')),date:String(f.get('date'))};
        const body=JSON.stringify(payload);if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
        setProposal(await proposeExpense(payload,attempt.current.key));setFolio('');
      });}}><label className="form-field"><span>Instrucción de gasto</span><textarea name="instruction" required placeholder="gasto de 35.10 en OT-7 por aceite"/></label>
        <div className="form-grid"><label className="form-field"><span>Categoría indicada</span><input name="category" required/></label>
          <label className="form-field"><span>Cuenta indicada</span><input name="account" required/></label></div>
        <label className="form-field"><span>Medio indicado</span><select aria-label="Medio indicado" name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
        <label className="form-field"><span>Fecha indicada</span><input name="date" type="date" defaultValue={localToday()} required/></label><Button type="submit" disabled={busy}>Preparar propuesta sin registrar gasto</Button>
      </form>
      {proposal&&<article className="inline-note mt-4"><h3 className="font-semibold">Propuesta exacta por confirmar</h3>
        <p>{proposal.payload.concept} · {money(Number(proposal.payload.amount))}</p><p>Destino: {proposal.payload.operationId??proposal.payload.costCenterId}</p>
        <p>{proposal.payload.date} · {proposal.payload.method} · {proposal.payload.account} · {proposal.payload.category}</p>
        <small className="break-all">Hash {proposal.payload_hash} · vence {proposal.expires_at}</small>
        {folio?<p>Gasto registrado una sola vez: <strong>{folio}</strong></p>:<Button className="mt-3" disabled={busy} onClick={()=>{void run(async()=>{
          const result=await confirmExpense(proposal);setFolio(result.id);await refresh();
        });}}>Confirmar exactamente este gasto</Button>}
      </article>}
    </section>}
    {error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </>;
}
