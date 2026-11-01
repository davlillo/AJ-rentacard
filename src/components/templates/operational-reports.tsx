'use client';
import {useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {ReportesScreen} from './reportes-screen';
import {money} from '@/controladores/finanzas';
import {commissionCommand,loadCommissions,vehicleContribution,type CommissionRule,type CommissionEntry,type VehicleContribution} from '@/lib/supabase/management';
import {loadBilling,localToday,type Receivable} from '@/lib/supabase/billing';
import {loadCalendar,type Reservation} from '@/lib/supabase/reservations';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';

export function ReportsScreen(){const {source}=useBusiness();return source==='supabase'?<ReportsWorkspace/>:<ReportesScreen/>;}
function ReportsWorkspace(){
  const {data,can}=useBusiness();const [report,setReport]=useState<VehicleContribution|null>(null);const [rules,setRules]=useState<CommissionRule[]>([]);
  const [entries,setEntries]=useState<CommissionEntry[]>([]);const [bookings,setBookings]=useState<Reservation[]>([]);const [documents,setDocuments]=useState<Receivable[]>([]);
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function reload(){const loaded=await loadCommissions();setRules(loaded.rules);setEntries(loaded.entries);setDocuments((await loadBilling(localToday())).documents);if(can('orders.read'))setBookings((await loadCalendar()).reservations);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[]);
  async function run(action:()=>Promise<void>){if(sending.current)return;sending.current=true;setBusy(true);setError('');try{await action();}catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}}
  async function submit(command:'rule'|'calculate'|'eligibility',payload:Record<string,unknown>){const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};await commissionCommand(command,payload,attempt.current.key);await reload();attempt.current=null;}
  return <><PageHeading eyebrow="MAGNITUDES DISTINTAS / FUENTES COMPROBABLES" title="Margen directo y comisiones"
    description="Contribución facturada menos costos directos. No es flujo de caja ni utilidad neta; no incluye costos laborales sin política aprobada."/>
    <form className="panel p-5 operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>setReport(await vehicleContribution(String(f.get('vehicleId')),String(f.get('from')),String(f.get('cutoff')))));}}>
      <label className="form-field"><span>Vehículo del reporte</span><select aria-label="Vehículo del reporte" name="vehicleId" required>{data.vehicles.map(v=><option key={v.id} value={v.id}>{v.plate} · {v.brand} {v.model}</option>)}</select></label>
      <div className="form-grid"><label className="form-field"><span>Reporte desde</span><input name="from" type="date" required defaultValue={localToday().slice(0,8)+'01'}/></label>
        <label className="form-field"><span>Corte del reporte</span><input name="cutoff" type="date" required defaultValue={localToday()}/></label></div>
      <Button type="submit" disabled={busy}>Calcular contribución y ver fuentes</Button>
    </form>
    {report&&<section className="panel p-5 mt-5"><h2 className="font-semibold">{report.plate} · Contribución directa {money(report.contribution)}</h2>
      <p>Facturado {money(report.billedIncome)} − costo directo {money(report.actualDirectCost)}</p><small>{report.policy} · {report.from} → {report.cutoff}</small>
      <div className="table-scroll mt-4"><AdaptiveTable><thead><tr><th>Fuente</th><th>Concepto</th><th>Fecha</th><th>Importe</th></tr></thead><tbody>
        {[...report.income.map(r=>({...r,kind:'Ingreso facturado'})),...report.costs.map(r=>({...r,kind:'Costo directo'}))].map(r=><tr key={r.id}><td>{r.kind}<small>{r.id}</small></td><td>{r.description}</td><td>{r.date}</td><td>{money(r.amount)}</td></tr>)}
      </tbody></AdaptiveTable></div></section>}
    <section className="panel p-5 mt-5"><h2 className="font-semibold">Comisiones por cobro elegible neto</h2><p className="field-hint">La tasa la registra gerencia, nunca se inventa. Un reembolso genera ajuste; un reintento no liquida dos veces. Las garantías no deben emitirse como cargos comerciales elegibles.</p>
      <details className="mt-4"><summary>Nueva revisión de regla de comisión (gerencia)</summary><form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
        void run(async()=>{await submit('rule',{code:String(f.get('code')),rate:(Number(f.get('rate'))/100).toFixed(6),validFrom:String(f.get('validFrom')),validUntil:String(f.get('validUntil'))});});
      }}><label className="form-field"><span>Código de regla</span><input name="code" required/></label><label className="form-field"><span>Tasa de comisión (%)</span><input name="rate" type="number" min="0" max="100" step="0.0001" required/></label>
        <label className="form-field"><span>Vigente desde</span><input name="validFrom" type="date" required/></label><label className="form-field"><span>Vigente hasta</span><input name="validUntil" type="date" required/></label>
        <Button type="submit" disabled={busy}>Guardar regla versionada</Button>
      </form></details>
      <details className="mt-4"><summary>Revisar elegibilidad de documento (gerencia)</summary><form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
        void run(async()=>{await submit('eligibility',{documentId:String(f.get('documentId')),eligible:f.get('eligible')==='on',reason:String(f.get('reason'))});});
      }}><label className="form-field"><span>Documento de comisión</span><select aria-label="Documento de comisión" name="documentId" required>{documents.map(d=><option key={d.id} value={d.id}>{d.description} · {d.id}</option>)}</select></label>
        <label><input name="eligible" type="checkbox"/> Cobro comercial elegible (no garantía)</label><label className="form-field"><span>Motivo de elegibilidad</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Guardar decisión de elegibilidad</Button>
      </form></details>
      <form className="operation-form mt-4" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void run(async()=>{await submit('calculate',{reservationId:String(f.get('reservationId')),ruleId:String(f.get('ruleId')),cutoff:String(f.get('cutoff'))});});}}>
        <label className="form-field"><span>Reserva a liquidar</span><select aria-label="Reserva a liquidar" name="reservationId" required>{bookings.map(b=><option key={b.id} value={b.id}>{b.customer_snapshot.name} · {b.id}</option>)}</select></label>
        <label className="form-field"><span>Revisión de regla aplicada</span><select aria-label="Revisión de regla aplicada" name="ruleId" required>{rules.map(r=><option key={r.id} value={r.id}>{r.code} V{r.revision} · {r.rate*100}%</option>)}</select></label>
        <label className="form-field"><span>Corte de comisión</span><input name="cutoff" type="date" defaultValue={localToday()} required/></label><Button type="submit" disabled={busy}>Calcular ajuste de comisión</Button>
      </form>
      <div className="table-scroll mt-5"><AdaptiveTable><thead><tr><th>Reserva / vendedor</th><th>Regla / corte</th><th>Base elegible</th><th>Movimiento de comisión</th></tr></thead><tbody>{entries.map(e=><tr key={e.id}><td>{e.reservation_id}<small>{e.seller_id}</small></td><td>{e.rule_id}<small>{e.cutoff}</small></td><td>{money(e.eligible_base)}</td><td>{money(e.amount)}<small>{e.id}</small></td></tr>)}</tbody></AdaptiveTable></div>
    </section>{error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </>;
}
