'use client';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {RefreshCw} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {VehicleImage} from '@/components/organisms/vehicle-image';
import {RegistryDetails} from '@/components/organisms/registry-details';
import {WorkshopStageProgress} from '@/components/organisms/workshop-stage-progress';
import {WorkshopCosts} from '@/components/organisms/workshop-costs';
import {WorkshopDeliveryReview} from '@/components/organisms/workshop-delivery';
import {WorkshopCollections,WorkshopIssueForm} from '@/components/organisms/workshop-collections';
import {CaseQuotes} from '@/components/organisms/case-quotes';
import {BudgetEditor,type BudgetEditorSeed} from '@/components/templates/operational-estimates';
import {workshopPipeline,resolvedSection,workshopMoney,workshopSection,type WorkshopSection} from '@/controladores/workshop-pipeline';
import {workshopMoneyLabels,workshopCollectionState} from '@/controladores/workshop-money-language';
import {stageAdvance,typingInFolio} from '@/controladores/stage-advance';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {clarityLabels,RE_APPROVAL_NOTICE,needsClientApproval} from '@/controladores/budget-clarity';
import {executeTaskCommand,normalizeResponsibleName,responsibleNameMaxLength,responsibleNameMigrationMessage,workshopAssignees,
  type WorkshopAssignee} from '@/lib/supabase/tasks';
import {orderHref,vehicleHref,type CaseFile,type CaseOrder} from '@/lib/supabase/cases';
import styles from './workshop-case-screen.module.css';import {TaskBoard} from '@/components/organisms/task-board';


export function WorkshopCaseScreen({file,job,onChange:onReload,receptionSlot,filesSlot,error}:{
  file:CaseFile;job:CaseOrder;onChange:()=>Promise<void>;receptionSlot:ReactNode;filesSlot:ReactNode;error?:string;
}){
  const {data,can,toast}=useBusiness();
  const requested=useSearchParams().get('seccion');
  const [section,setSection]=useState<WorkshopSection>(()=>resolvedSection(workshopSection(requested),job));
  const [refreshing,setRefreshing]=useState(false);const [refreshError,setRefreshError]=useState('');
  // The budget editor opens inline, in place, without leaving the folio.
  const [seed,setSeed]=useState<BudgetEditorSeed|null>(null);
  useEffect(()=>{setSection(resolvedSection(workshopSection(requested),job));},[requested]);
  const financial=file.financialAccess&&can('expenses.read');
  const pipeline=workshopPipeline(file,job,financial);const amounts=financial?workshopMoney(file,job.id):null;
  // After a successful action the folio moves to the stage that now applies and says so.
  // The circles stay as navigation and a manual pick is respected until the next action.
  const [actionReload,setActionReload]=useState(0);const [advanceNotice,setAdvanceNotice]=useState('');
  const sequence=useRef(0);const manualAt=useRef(0);const actionAt=useRef(0);
  const previousCurrent=useRef<WorkshopSection|null>(null);const pipelineRef=useRef(pipeline);
  const folioRef=useRef<HTMLDivElement>(null);
  pipelineRef.current=pipeline;
  function sectionLabel(key:WorkshopSection):string{
    return pipeline.stages.find(stage=>stage.key===key)?.label
      ??(key==='summary'?'Resumen':key==='documents'?'Fotos y documentos':key);
  }
  // Every caller of this reload runs it after its own command succeeded: that reload is
  // the only trigger of the automatic advance. The manual refresh uses the plain one.
  const onChange=useCallback(async()=>{
    actionAt.current=++sequence.current;previousCurrent.current=pipelineRef.current.current;
    await onReload();setActionReload(value=>value+1);
  },[onReload]);
  // The derived stage is persisted evidence: whenever it changes on its own, the folio
  // follows it. A child that saves through its own command still lands here, and a manual
  // circle pick is respected until the next real change.
  useEffect(()=>{
    const observed=previousCurrent.current;
    if(observed===pipeline.current)return;
    previousCurrent.current=pipeline.current;
    const decision=stageAdvance({previous:observed,current:pipeline.current,confirmed:true,
      dirty:typingInFolio(folioRef.current),manual:manualAt.current>actionAt.current});
    if(decision.advance&&decision.stage){
      setSection(decision.stage);setAdvanceNotice(`Avanzó a: ${sectionLabel(decision.stage)}`);
    }
  },[pipeline.current]);
  // The price that governs the job is the approved scope; a newer draft never replaces it.
  const approvedScope=pipeline.approved?Number(pipeline.approved.snapshot.total):null;
  const pendingScope=pipeline.approved&&pipeline.latest&&pipeline.latest.id!==pipeline.approved.id?
    Number(pipeline.latest.snapshot.total):null;
  const scopeQuote=pipeline.approved??amounts?.quote;
  const scopePrice=approvedScope??amounts?.quoted??null;
  // The approval decision is registered when the active scope is the approved
  // revision itself; only then does the issuance of the importe make sense.
  const decided=!!pipeline.approved&&!!pipeline.latest&&pipeline.latest.id===pipeline.approved.id;
  const scopeNote=approvedScope!==null?`Alcance aprobado · Versión ${pipeline.approved!.revision}`:
    `Última revisión · ${amounts?.quote?.status??'Por preparar'}`;
  const car=file.vehicle;
  const cover=file.files.filter(item=>item.mime.startsWith('image/')&&!item.financial).sort((a,b)=>
    Number(b.purpose==='Vehículo')-Number(a.purpose==='Vehículo')||b.created_at.localeCompare(a.created_at))[0]?.id
    ??data.vehicles.find(vehicle=>vehicle.id===car.id)?.primaryPhotoId;
  function select(next:WorkshopSection){manualAt.current=++sequence.current;setAdvanceNotice('');setSection(next);}
  // One editor seed for the first quote and for editing an existing draft: the same
  // canonical save, the same parent revision and the same re-approval notice.
  function startEditor(){
    const latest=pipeline.latest;
    setSeed({
      lines:latest?latest.snapshot.lines.map(line=>({description:line.description,kind:line.kind,
        quantity:String(line.quantity),unitPrice:String(line.unitPrice),unitCost:line.unitCost===null?'':String(line.unitCost)})):
        [{description:'',kind:'Material',quantity:'1',unitPrice:'',unitCost:''}],
      discount:String(latest?.snapshot.discount??0),parentId:latest?.id??null,section:'costs'});
  }
  async function savedBudget(){setSeed(null);await onChange();}
  const restricted=['budget','approval','collections'].includes(section)&&!financial;
  return <div className={`vehicle-case ${styles.screen}`} data-testid="workshop-case" ref={folioRef}>
    <nav aria-label="Ubicación del expediente" className="mb-5"><Link href="/taller">Taller</Link> / <Link href={vehicleHref(car.id)}>{car.plate||`${car.brand} ${car.model}`}</Link> / {folio('OT',job.id)}</nav>
    <PageHeading eyebrow={job.internal_job?'MANTENIMIENTO INTERNO':'TRABAJO DE CLIENTE'}
      title={`${folio('OT',job.id)} · ${car.plate||car.brand+' '+car.model}`}
      description={`${job.service} · Estado del trabajo: ${job.status}`}
      actions={<Button variant="outline" disabled={refreshing} onClick={()=>{
        setRefreshing(true);setRefreshError('');void onReload().then(()=>toast('Expediente actualizado.'))
          .catch(error=>setRefreshError(error.message)).finally(()=>setRefreshing(false));
      }}><RefreshCw size={15} className={refreshing?'animate-spin':''}/>{refreshing?'Actualizando…':'Actualizar expediente'}</Button>}/>
    <div className={styles.identity}><span>{job.internal_job?'Mantenimiento interno · no es venta':'Trabajo para cliente'}</span>
      <span>{car.in_rental_fleet?'Incluido en flota de alquiler':'Fuera de flota de alquiler'}</span><span>Propiedad: {car.ownership}</span></div>
    <WorkshopStageProgress pipeline={pipeline} onSelect={select} selected={section}
      utilities={[{key:'summary',label:'Resumen',place:'start'},{key:'tasks',label:'Tareas',place:'end'},{key:'documents',label:'Fotos y documentos',place:'end'}]}/>
    {advanceNotice&&<p className={styles.advanceNotice} role="status">{advanceNotice}</p>}
    {restricted?<p className="inline-note">Información financiera restringida. Puede continuar con el diagnóstico autorizado.</p>:<>
      {section==='summary'&&<section className="panel p-5">
        <div className="case-overview"><VehicleImage vehicleId={car.id} plate={car.plate} fileId={cover} size="detail" editable onChange={onChange}/>
          <dl className="detail-list"><div><dt>Vehículo</dt><dd>{car.brand} {car.model} · {car.year} · {car.plate}</dd></div>
            <div><dt>Cliente / destino</dt><dd>{job.internal_job?'Mantenimiento interno':data.customers.find(customer=>customer.id===job.customer_id)?.name??'Sin acceso al cliente'}</dd></div>
            <div><dt>Titular registral</dt><dd>{car.registered_holder||'Pendiente de registrar'}</dd></div>
            <div><dt>Línea comercial</dt><dd>{car.commercial_line||'Sin clasificar'}</dd></div>
            <div><dt>Kilometraje actual</dt><dd>{car.unverified_fields?.includes('km')?'Por confirmar':`${car.km.toLocaleString()} km`}</dd></div>
            <div><dt>Recepción física</dt><dd>{job.status==='Presupuesto'?'Aún no se ha recibido':new Date(job.occurred_at).toLocaleString('es-SV',{timeZone:'America/El_Salvador'})}</dd></div>
            <div><dt>Datos de recepción pendientes</dt><dd>{job.pending_fields.join(', ')||'Ninguno'}</dd></div>
          </dl></div>
        {can('vehicles.write')&&<RegistryDetails vehicle={car} onChange={onChange}/>}
        <div className={styles.next}><strong>{pipeline.current?'Siguiente revisión recomendada':'Trabajo entregado'}</strong>
          <p>{pipeline.description}</p>{pipeline.current&&<Button variant="outline" onClick={()=>select(pipeline.current!)}>Abrir fase recomendada</Button>}</div>
        {amounts&&<section className={styles.money} aria-label="Importes de este trabajo"><h2>Importes de este trabajo</h2>
          <p>{job.internal_job
            ?'Los costos del taller y sus pagos al proveedor se revisan en la etapa «Costos reales».'
            :'Lo que el cliente debe de este trabajo. Los costos del taller y sus pagos al proveedor se revisan en la etapa «Cobros».'}</p>
          <dl>
            {!job.internal_job&&<><div><dt>Precio del presupuesto · cliente</dt><dd>{scopePrice===null?'Sin presupuesto':money(scopePrice)}</dd><small>{scopeNote}</small></div>
              <div><dt>Importe a cobrar · emitido</dt><dd>{money(amounts.charged)}</dd></div>
              <div><dt>Cobros aplicados</dt><dd>{money(amounts.paid)}</dd></div>
              <div><dt>Saldo pendiente</dt><dd>{money(amounts.balance)}</dd></div>
            </>}
            {job.internal_job&&<div><dt>Costo presupuestado</dt><dd>{scopeQuote?money(scopeQuote.snapshot.cost):'Sin estimación'}</dd><small>{scopeNote}</small></div>}
          </dl>
          {pendingScope&&<p className="field-hint mt-3">Revisión pendiente de decisión · {money(pendingScope)}: no cambia lo acordado ni lo que se cobra.</p>}
          {!job.internal_job&&<p>{amounts.deliveredWithBalance?'Entregado con saldo pendiente':workshopCollectionState(amounts.collectionState)}.
            {' '}Los cobros se administran por separado; pagar no confirma trabajo ni entrega.</p>}
          <p className="field-hint mt-3"><button type="button" className="text-link" onClick={()=>select('collections')}>{job.internal_job?'Ver costos del trabajo →':'Ver cobros y costos del trabajo →'}</button></p>
        </section>}
        {!financial&&<p className="inline-note mt-5">Información financiera restringida.</p>}
      </section>}
      {section==='diagnosis'&&<>{job.status==='Presupuesto'&&<p className="inline-note mb-4">Este folio es de presupuesto, sin recepción física confirmada.</p>}
        {receptionSlot}
        <section className="panel p-5 mt-5"><h2 className="font-semibold">Responsable y diagnóstico</h2>
          <JobResponsible orderId={job.id}/>
          <p className="field-hint mt-3">El diagnóstico puede registrarse antes de la aprobación del presupuesto.</p>
        </section></>}
      {section==='budget'&&<section className="panel p-5"><h2 className="font-semibold">Costos y presupuesto</h2>
        <p className="inline-note mt-3">Primero estime los costos internos; después defina manualmente el precio al cliente. No se agrega margen automático.</p>
        {pipeline.latest?<BudgetVersionSummary quote={pipeline.latest} seed={seed}/>
          :<p className="field-hint mt-4">Este trabajo todavía no tiene presupuesto. Cree la primera versión aquí mismo.</p>}
        <div className="mt-4"><Button variant={seed?'outline':undefined} disabled={!can('expenses.write')} onClick={()=>{
          if(seed){setSeed(null);return;}startEditor();
        }}>{seed?'Cerrar el editor del presupuesto':pipeline.latest?'Editar el presupuesto del trabajo':'Crear el presupuesto del trabajo'}</Button></div>
        {seed&&<BudgetEditor orderId={job.id} seed={seed} onChange={onChange} onSaved={savedBudget} onClosed={()=>setSeed(null)}/>}
      </section>}
      {section==='approval'&&<section className="panel p-5"><h2 className="font-semibold mb-4">Aprobación del cliente</h2>
        {decided&&!job.internal_job&&job.status!=='Entregado'&&<section className={styles.issueCard} aria-label="Emitir importe a cobrar">
          <h3>Emitir importe a cobrar</h3>
          <p>Trabajo acordado aprobado: <strong>{approvedScope===null?'Sin importe':money(approvedScope)}</strong></p>
          <p>Registra el documento de cobro. No recibe dinero ni cambia el costo.</p>
          {amounts&&amounts.unbilled>0?<WorkshopIssueForm file={file} job={job} onChange={onChange}/>
            :<p className="field-hint">El alcance aprobado ya tiene su documento de cobro emitido.{' '}
              <button type="button" className="text-link" onClick={()=>select('collections')}>Ver cobros →</button></p>}
        </section>}
        {pipeline.latest?<CaseQuotes file={file} job={job} onChange={onChange}/>
          :<><p className="field-hint">Todavía no hay un presupuesto que el cliente pueda decidir.</p>
            <div className="mt-4"><Button onClick={()=>{select('budget');startEditor();}}>Crear el presupuesto del trabajo</Button></div></>}
      </section>}
      {section==='collections'&&financial&&<section className="panel p-5">
        <h2 className="font-semibold mb-4">{job.internal_job?'Costos reales del trabajo':'Cobros de este trabajo'}</h2>
        {!job.internal_job&&pipeline.current==='approval'&&<p className="inline-note mb-4">El alcance vigente sigue siendo el aprobado; la última revisión espera su decisión. <button type="button" className="text-link" onClick={()=>select('approval')}>Revisar aprobación →</button></p>}
        {job.internal_job?<><p className="inline-note mb-4">{workshopMoneyLabels.internalNote}</p>
          <WorkshopCosts orderId={job.id} file={file} onChange={onChange}/></>
          :<WorkshopCollections file={file} job={job} onChange={onChange}/>}
      </section>}
      {section==='delivery'&&<section className="panel p-5"><h2 className="font-semibold mb-4">Entrega revisada</h2>
        {car.in_rental_fleet&&<p className="inline-note mb-4">La entrega de taller no confirma limpieza ni disponibilidad para renta. <Link href="/vehiculos/bloqueos">Revise la liberación en Bloqueos.</Link></p>}
        {financial&&can('expenses.write')?<WorkshopDeliveryReview orderId={job.id} onChange={onChange}
          quoteLabels={Object.fromEntries((file.quotes??[]).map(quote=>[quote.id,`${folio('PRE',quote.folio_number)} · Versión ${quote.revision}`]))}/>:<p>La revisión final requiere autorización financiera. Estado del trabajo: {job.status}.</p>}
      </section>}
      {section==='tasks'&&<section className="panel p-5"><h2 className="font-semibold">Tareas del trabajo</h2>
        <p className="field-hint mt-2">Seguimiento opcional: las tareas abiertas no impiden entregar el vehículo.</p>
        {can('tasks.read')?<div className="mt-4"><TaskBoard orderId={job.id}/></div>:<p className="mt-4">La consulta de tareas requiere autorización.</p>}</section>}
      {section==='documents'&&filesSlot}
    </>}
    {(error||refreshError)&&<p role="alert" className="form-error mt-4">{error||refreshError}</p>}
    <Link className="text-link mt-5 inline-block" href={orderHref(job.id)+'&seccion='+encodeURIComponent('Resumen')}>Enlace al resumen del folio</Link>
  </div>;
}

// The version numbers of the stage stay visible while the editor works: the operator
// has to know which revision is being replaced before writing a new one.
function BudgetVersionSummary({quote,seed}:{quote:NonNullable<ReturnType<typeof workshopPipeline>['latest']>;seed:BudgetEditorSeed|null}){
  const total=quote.snapshot.total;
  const reApproval=needsClientApproval([{id:quote.id,parent_id:quote.parent_id,status:quote.status}],quote.id);
  return <div className="mt-4">
    <p><strong>{folio('PRE',quote.folio_number)} · Versión {quote.revision} · {quote.status}</strong>
      {' · '}Costo interno {quote.snapshot.costComplete===false?clarityLabels.missingCost:money(quote.snapshot.cost)}
      {' · '}Precio al cliente {money(total)}</p>
    <p className="field-hint">{seed?'Se guardará una nueva versión de este mismo folio y la actual no cambia.':'Se edita sobre una nueva versión: la anterior se conserva.'}</p>
    {reApproval&&<p className="inline-note mt-3" role="status"><strong>Requiere una nueva aprobación del cliente.</strong> {RE_APPROVAL_NOTICE}</p>}
  </div>;
}

// The responsible person is a plain typed name. The account behind it keeps the
// permissions and the timers, but it never stands in front of the operator.
function JobResponsible({orderId}:{orderId:string}){
  const {data,can,refresh,toast}=useBusiness();
  const task=(data.tasks??[]).find(row=>row.orderId===orderId);
  const manager=can('orders.write');
  const nameAvailable=data.taskResponsibleNameAvailable!==false;
  const [name,setName]=useState(task?.responsibleName??'');
  const [staff,setStaff]=useState<WorkshopAssignee[]>([]);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const attempt=useRef<{body:string;key:string}|null>(null);
  useEffect(()=>{setName(task?.responsibleName??'');},[task?.responsibleName]);
  useEffect(()=>{let active=true;
    if(manager)void workshopAssignees().then(rows=>{if(active)setStaff(rows);}).catch(()=>{});
    return()=>{active=false;};},[manager]);
  if(!manager)return <p className="field-hint">{task?.responsibleName?`Responsable: ${task.responsibleName}`:'Sin nombre de responsable registrado.'}</p>;
  async function save(){
    if(busy)return;
    let value:string|null;
    try{value=normalizeResponsibleName(name);}
    catch(cause){setError((cause as Error).message);return;}
    if(!nameAvailable&&value){setError(responsibleNameMigrationMessage);return;}
    // The account of the task is preserved; a name never reassigns it silently.
    const payload=task?{taskId:task.id,expectedVersion:task.version,assignedTo:task.assignedTo,
      reason:'Responsable del trabajo',...(value?{responsibleName:value}:{})}
      :{orderId,description:'Responsable del trabajo',assignedTo:staff[0]?.id??'',
        ...(value?{responsibleName:value}:{})};
    if(!task&&!payload.assignedTo){setError('No hay una cuenta de seguimiento autorizada.');return;}
    const command=task?'assign':'create';
    const body=JSON.stringify({command,payload});
    if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    setBusy(true);setError('');
    try{
      await executeTaskCommand(command,payload,attempt.current.key);
      attempt.current=null;
      await refresh().catch(()=>setError('El nombre se guardó, pero falta actualizar la vista.'));
      toast('Responsable del trabajo guardado.');
    }catch(cause){setError((cause as Error).message);}
    finally{setBusy(false);}
  }
  return <form className="operation-form mt-3" onSubmit={event=>{event.preventDefault();void save();}}>
    <label className="form-field"><span>Responsable del trabajo</span>
      <input aria-label="Responsable del trabajo" maxLength={responsibleNameMaxLength} disabled={busy||!nameAvailable}
        value={name} onChange={event=>setName(event.target.value)}
        placeholder="Escriba el nombre de quien hace el trabajo"/></label>
    <p className="field-hint">Es un nombre escrito. La cuenta de seguimiento de los permisos y cronómetros no cambia.</p>
    {!nameAvailable&&<p className="inline-note" role="status">{responsibleNameMigrationMessage}</p>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    <Button type="submit" variant="outline" disabled={busy}>{busy?'Guardando…':'Guardar responsable'}</Button>
  </form>;
}
