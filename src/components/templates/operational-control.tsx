'use client';
import {useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {ConfiguracionScreen} from './configuracion-screen';
import {loadControl,administrationCommand,optionalCommand,reportDeliveryCommand,budgetPosition,type AdministrationUser,type OperatingBudget,type IntegrationEvent,type ReportJob,type BudgetPosition} from '@/lib/supabase/control';
import {loadInventory,type PurchaseOrder} from '@/lib/supabase/inventory';
import {localToday} from '@/lib/supabase/billing';
import {money} from '@/controladores/finanzas';

type Field={name:string;label:string;type?:string;value?:string;optional?:boolean;options?:{value:string;label:string}[]};
function ControlForm({title,fields,submitLabel,onSubmit,busy}:{title:string;fields:Field[];submitLabel:string;onSubmit:(values:Record<string,string>)=>void;busy:boolean}){
  return <details className="panel p-5 mt-4"><summary>{title}</summary><form className="operation-form" onSubmit={event=>{event.preventDefault();onSubmit(Object.fromEntries(new FormData(event.currentTarget)) as Record<string,string>);}}>
    {fields.map(field=><label className="form-field" key={field.name}><span>{field.label}</span>
      {field.options?<select aria-label={field.label} name={field.name} required={!field.optional} defaultValue={field.value}>{field.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:
        field.type==='textarea'?<textarea name={field.name} required={!field.optional} defaultValue={field.value}/>:
          <input name={field.name} type={field.type??'text'} step={field.type==='number'?'0.01':undefined} required={!field.optional} defaultValue={field.value}/>}
    </label>)}<Button type="submit" disabled={busy}>{submitLabel}</Button>
  </form></details>;
}
export function ControlScreen(){const {source}=useBusiness();return source==='supabase'?<ControlWorkspace/>:<ConfiguracionScreen/>;}
function ControlWorkspace(){
  const {data,refresh}=useBusiness();const [users,setUsers]=useState<AdministrationUser[]>([]);const [budgets,setBudgets]=useState<OperatingBudget[]>([]);
  const [events,setEvents]=useState<IntegrationEvent[]>([]);const [jobs,setJobs]=useState<ReportJob[]>([]);const [purchases,setPurchases]=useState<PurchaseOrder[]>([]);
  const [position,setPosition]=useState<BudgetPosition|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function reload(){const result=await loadControl();setUsers(result.users);setBudgets(result.budgets);setEvents(result.events);setJobs(result.jobs);setPurchases((await loadInventory()).purchases);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[]);
  async function run(action:()=>Promise<void>){if(sending.current)return;sending.current=true;setBusy(true);setError('');try{await action();}catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}}
  async function submit(area:'admin'|'optional'|'delivery',command:string,payload:Record<string,unknown>){
    const body=JSON.stringify({area,command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    await(area==='admin'?administrationCommand:area==='optional'?optionalCommand:reportDeliveryCommand)(command,payload,attempt.current.key);
    await reload();await refresh();attempt.current=null;
  }
  const userOptions=users.map(u=>({value:u.id,label:`${u.email} · ${u.roles.join(', ')}`}));
  const vehicleOptions=data.vehicles.map(v=>({value:v.id,label:v.plate}));
  const budgetOptions=budgets.map(b=>({value:b.id,label:`${b.name} · ${b.id}`}));
  const purchaseOptions=purchases.map(p=>({value:p.id,label:`${p.supplier} · ${p.id}`}));
  return <><PageHeading eyebrow="GERENCIA / PERMISOS / TRAZABILIDAD" title="Control operativo"
    description="Solo gerencia administra roles, programa reportes y habilita planes o eventos externos. Las escrituras quedan auditadas."/>
    <ControlForm title="Asignar o revocar rol" busy={busy} submitLabel="Guardar cambio de rol" fields={[
      {name:'userId',label:'Usuario de administración',options:userOptions},{name:'command',label:'Acción de rol',options:[{value:'grant_role',label:'Asignar rol'},{value:'revoke_role',label:'Revocar rol'}]},
      {name:'role',label:'Rol de negocio',options:['owner','admin','reception','technician','accountant'].map(role=>({value:role,label:role}))},{name:'reason',label:'Motivo del cambio de rol'}
    ]} onSubmit={({command,...values})=>{void run(async()=>{await submit('admin',command,values);});}}/>
    <ControlForm title="Registrar centro de costo" busy={busy} submitLabel="Guardar centro de costo" fields={[
      {name:'id',label:'Código de centro de costo'},{name:'name',label:'Nombre del centro de costo'},{name:'reason',label:'Motivo del catálogo'}
    ]} onSubmit={values=>{void run(async()=>{await submit('admin','cost_center',values);});}}/>
    <ControlForm title="Programar reporte periódico" busy={busy} submitLabel="Guardar programación de reporte" fields={[
      {name:'recipientId',label:'Destinatario autorizado',options:userOptions},{name:'vehicleId',label:'Vehículo programado',options:vehicleOptions},
      {name:'from',label:'Periodo del reporte desde',type:'date',value:localToday()},{name:'nextOn',label:'Primer corte programado',type:'date',value:localToday()},
      {name:'everyDays',label:'Periodicidad en días',type:'number',value:'7'}
    ]} onSubmit={values=>{void run(async()=>{await submit('delivery','schedule',values);});}}/>
    <div className="panel p-5 mt-4"><Button disabled={busy} onClick={()=>{void run(async()=>{await submit('delivery','prepare',{runDate:localToday()});});}}>Preparar reportes vencidos al corte de hoy</Button>
      <p className="field-hint mt-3">El trabajador captura el correo en Mailpit local, no en servicios públicos. Un estado de envío incierto requiere revisión; no se reenvía a ciegas.</p>
      {jobs.map(job=><p key={job.id} className="mt-3">{job.cutoff} · {job.recipient_email} · <strong>{job.state}</strong><small>{job.id} · {job.message_id}</small></p>)}
    </div>
    <ControlForm title="Crear presupuesto operativo" busy={busy} submitLabel="Guardar presupuesto operativo" fields={[
      {name:'name',label:'Nombre del presupuesto'},{name:'area',label:'Área del presupuesto'},{name:'category',label:'Categoría del presupuesto'},
      {name:'startsOn',label:'Inicio del presupuesto',type:'date',value:localToday()},{name:'endsOn',label:'Fin del presupuesto',type:'date',value:localToday()},
      {name:'authorized',label:'Importe autorizado del presupuesto',type:'number'}
    ]} onSubmit={values=>{void run(async()=>{await submit('optional','budget',values);});}}/>
    <ControlForm title="Vincular compra al presupuesto" busy={busy} submitLabel="Vincular compra planificada" fields={[
      {name:'budgetId',label:'Plan de la compra',options:budgetOptions},{name:'purchaseId',label:'Compra comprometida',options:purchaseOptions}
    ]} onSubmit={values=>{void run(async()=>{await submit('optional','link_purchase',values);});}}/>
    <ControlForm title="Vincular gasto o pago sin duplicar ejecución" busy={busy} submitLabel="Vincular gasto al plan" fields={[
      {name:'budgetId',label:'Plan del gasto',options:budgetOptions},{name:'expenseId',label:'Gasto del plan',options:data.movements.filter(m=>m.type==='Egreso').map(m=>({value:m.id,label:`${m.id} · ${m.concept}`}))},
      {name:'purchaseId',label:'Compra ya recibida que paga este gasto',optional:true,options:[{value:'',label:'Gasto independiente'},...purchaseOptions]},
      {name:'reason',label:'Motivo de vinculación presupuestaria'}
    ]} onSubmit={values=>{void run(async()=>{await submit('optional','link_expense',{...values,purchaseId:values.purchaseId||null});});}}/>
    <ControlForm title="Consultar plan, comprometido y ejecutado" busy={busy} submitLabel="Consultar posición presupuestaria" fields={[
      {name:'budgetId',label:'Presupuesto a consultar',options:budgetOptions},{name:'cutoff',label:'Corte presupuestario',type:'date',value:localToday()}
    ]} onSubmit={values=>{void run(async()=>{setPosition(await budgetPosition(values.budgetId,values.cutoff));});}}/>
    {position&&<div className="panel p-5 mt-4"><p>Plan {money(position.authorized)} · Comprometido {money(position.committed)} · Ejecutado {money(position.executed)} · Disponible {money(position.available)}</p>
      {position.sources.map(source=><p key={source.id}>{source.kind} · {money(source.amount)}<small>{source.id}</small></p>)}</div>}
    <ControlForm title="Registrar evento de integración autorizado" busy={busy} submitLabel="Guardar evento en inbox" fields={[
      {name:'source',label:'Sistema de origen'},{name:'externalId',label:'Identificador externo del evento'},
      {name:'event',label:'Datos del gasto externo (JSON)',type:'textarea'}
    ]} onSubmit={values=>{void run(async()=>{await submit('optional','enqueue',{...values,event:JSON.parse(values.event)});});}}/>
    <section className="panel p-5 mt-4"><h2 className="font-semibold">Inbox y recuperación</h2><p className="field-hint">Adaptador local autorizado para gastos. No se han configurado credenciales fiscales ni de WhatsApp.</p>
      {events.map(event=><article key={event.id} className="inline-note mt-3"><p>{event.source} / {event.external_id} · {event.state} · intentos {event.attempts}</p>
        <small>{event.last_error??event.result?.id??event.id}</small><Button variant="outline" className="mt-2" disabled={busy} onClick={()=>{void run(async()=>{await submit('optional','process',{eventId:event.id});});}}>Procesar o reintentar evento</Button>
      </article>)}
    </section>{error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </>;
}
