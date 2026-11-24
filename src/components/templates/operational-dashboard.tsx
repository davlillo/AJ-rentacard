'use client';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {useCallback,useMemo,useState,type ReactNode} from 'react';
import {ArrowDownLeft,ArrowUpRight,ArrowRight,CarFront,Wallet,Wrench,CalendarDays,Plus,
  CircleCheck,Clock3,Info,TriangleAlert,FileText} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {useDashboardRead} from '@/hooks/use-dashboard-read';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {activeWorkshopOrders,currentCommitments,dashboardCashSeries,dashboardFleet,dashboardReceivables,
  dashboardRentals,shiftDay,validDashboardPeriod,workshopStages,type DashboardPeriod,type FleetGroup} from '@/controladores/dashboard';
import {localToday,billingRpc,type Receivable} from '@/lib/supabase/billing';
import {loadDiary} from '@/lib/supabase/diary';
import {readRows} from '@/lib/supabase/business';
import type {Commitment} from '@/lib/supabase/reservations';
import {orderHref,rentalHref,vehicleHref} from '@/lib/supabase/cases';
import {cashChartOption,fleetChartOption,workshopChartOption,fleetLabels,fleetColors} from '@/components/organisms/dashboard-options';
import styles from './operational-dashboard.module.css';

const Chart=dynamic(()=>import('@/components/organisms/dashboard-chart').then(module=>module.DashboardChart),
  {ssr:false,loading:()=> <div className={styles.chartLoading} role="status">Preparando gráfica…</div>});
const loadCommitments=()=>readRows<Commitment>('vehicle_commitments',
  'id,vehicle_id,reservation_id,order_id,kind,starts_at,ends_at,active,reason');
const dateLabel=(day:string)=>new Date(day+'T12:00:00Z').toLocaleDateString('es-SV',{day:'numeric',month:'short',year:'numeric'});
const timeLabel=(date:Date)=>date.toLocaleTimeString('es-SV',{hour:'2-digit',minute:'2-digit',timeZone:'America/El_Salvador'});

function SectionHeading({id,title,description,action}:{id:string;title:string;description:string;action?:ReactNode}){
  return <header className={styles.sectionHeading}><div><h2 id={id}>{title}</h2><p className="sr-only">{description}</p></div>{action}</header>;
}

function ReadStatus({reading,label}:{reading:{error:boolean;loading:boolean;updatedAt?:Date;retry:()=>void};label:string}){
  if(!reading.error)return reading.loading&&!reading.updatedAt?<p className={styles.readStatus} role="status">Actualizando {label}…</p>:null;
  return <div className={styles.readError} role="alert"><TriangleAlert size={16}/><p>No se pudo actualizar {label}.
    {reading.updatedAt&&` Se muestra la lectura anterior de las ${timeLabel(reading.updatedAt)}.`}</p>
    <Button variant="outline" size="sm" onClick={reading.retry}>Reintentar</Button></div>;
}

export function OperationalDashboard(){
  const {data,can,open}=useBusiness();
  const finance=can('expenses.read'),vehicles=can('vehicles.read'),ordersAccess=can('orders.read');
  const today=localToday(),now=Math.floor(Date.now()/60000)*60000;
  const [choice,setChoice]=useState<'week'|'month'|'custom'>('month');
  const [custom,setCustom]=useState<DashboardPeriod>({from:today.slice(0,8)+'01',to:today});
  const [draft,setDraft]=useState(custom);
  const [fleetFilter,setFleetFilter]=useState<FleetGroup|undefined>();
  const [area,setArea]=useState('Todas');
  const [stageFilter,setStageFilter]=useState('');
  const [showJobs,setShowJobs]=useState(false);
  const period=useMemo(()=>choice==='custom'?custom:{from:choice==='week'?shiftDay(today,-6):today.slice(0,8)+'01',to:today},
    [choice,custom,today]);
  const loadCash=useCallback(()=>loadDiary(period.from,period.to),[period.from,period.to]);
  const loadDocuments=useCallback(()=>billingRpc<Receivable[]>('receivables_at',{cutoff:today}),[today]);
  const cash=useDashboardRead(finance,period.from+'/'+period.to,loadCash,data);
  const documents=useDashboardRead(finance,today,loadDocuments,data);
  const blocks=useDashboardRead(vehicles,'fleet',loadCommitments,data);
  const cashSeries=useMemo(()=>cash.value?dashboardCashSeries(cash.value.rows,period):undefined,[cash.value,period]);
  const groups=useMemo(()=>blocks.value?dashboardFleet(data,blocks.value,now):undefined,[data,blocks.value,now]);
  const cashOption=useMemo(()=>cashChartOption(cashSeries?.points??[]),[cashSeries]);
  const fleetOption=useMemo(()=>fleetChartOption(groups??[]),[groups]);
  const receivables=documents.value?dashboardReceivables(documents.value):undefined;
  const fleet=data.vehicles.filter(vehicle=>vehicle.inRentalFleet);
  const available=groups?.find(group=>group.name==='Disponible')?.vehicles.length;
  const rented=fleet.filter(vehicle=>vehicle.status==='Alquilado').length;
  const jobs=activeWorkshopOrders(data.orders);
  const filteredJobs=jobs.filter(job=>area==='Todas'||job.area===area);
  const stages=useMemo(()=>workshopStages.map(name=>({name,count:filteredJobs.filter(job=>job.status===name).length})),
    [data.orders,area]);
  const workshopOption=useMemo(()=>workshopChartOption(stages),[stages]);
  const rentals=dashboardRentals(data.reservationHistory??[],now);
  const cleaning=currentCommitments(blocks.value??[],now).filter(block=>block.kind==='Limpieza');
  const pendingQuotes=data.orders.filter(job=>job.status==='Presupuesto');
  const incomplete=jobs.filter(job=>job.pendingFields?.length);
  const selectedCars=(fleetFilter?groups?.find(group=>group.name===fleetFilter)?.vehicles:[])??[];
  const visibleJobs=filteredJobs.filter(job=>!stageFilter||job.status===stageFilter)
    .sort((a,b)=>a.due.localeCompare(b.due)||a.id.localeCompare(b.id));
  const alerts:{key:string;title:string;detail:string;href:string;count:number;urgent?:boolean}[]=[];
  if(ordersAccess){
    if(rentals.lateReturns.length)alerts.push({key:'returns',title:'Devoluciones atrasadas',
      detail:'Alquileres entregados cuya fecha prevista ya pasó.',href:'/calendario',count:rentals.lateReturns.length,urgent:true});
    if(rentals.lateDepartures.length)alerts.push({key:'departures',title:'Entregas por revisar',
      detail:'Reservas con inicio pasado y sin salida registrada.',href:'/calendario',count:rentals.lateDepartures.length});
    if(cleaning.length)alerts.push({key:'cleaning',title:'En limpieza',detail:'Bloqueos de limpieza vigentes en este momento.',
      href:'/vehiculos/bloqueos',count:cleaning.length});
    if(incomplete.length)alerts.push({key:'incomplete',title:'Ingresos con datos pendientes',
      detail:'Expedientes recibidos que necesitan completar información.',href:orderHref(incomplete[0].id),count:incomplete.length});
  }
  if(finance&&receivables?.overdue.length)alerts.unshift({key:'receivables',title:'Cargos vencidos',
    detail:`${money(receivables.overdueBalance)} de saldo vencido al día de hoy.`,href:'/cobros',count:receivables.overdue.length,urgent:true});
  if(can('expenses.write')&&pendingQuotes.length)alerts.push({key:'quotes',title:'Presupuestos sin ingreso',
    detail:'Todavía no son vehículos recibidos en taller.',href:'/presupuestos',count:pendingQuotes.length});

  return <div className={`business-dashboard ${styles.dashboard}`}>
    <PageHeading title="Resumen del negocio" description=""
      actions={can('orders.write')?<Button onClick={()=>open('orden')}><Plus size={16}/>Nueva entrada al taller</Button>:undefined}/>
    <div className={styles.metrics} aria-label="Indicadores actuales, independientes del período de caja">
      {vehicles&&<Link href="/vehiculos" className={`business-metric ${styles.metric}`} title="Sin reservas ni bloqueos vigentes">
        <div className={styles.metricTop}><span>Vehículos disponibles</span><CarFront size={21}/></div>
        <strong data-value="available">{available??'—'}<small> / {fleet.length}</small></strong>
      </Link>}
      {vehicles&&<Link href="/vehiculos" className={`business-metric ${styles.metric} ${styles.blue}`}>
        <div className={styles.metricTop}><span>Vehículos alquilados</span><ArrowUpRight size={21}/></div>
        <strong data-value="rented">{rented}</strong>
      </Link>}
      {ordersAccess&&<Link href="/taller" className={`business-metric ${styles.metric} ${styles.purple}`}>
        <div className={styles.metricTop}><span>Trabajos en taller</span><Wrench size={21}/></div>
        <strong data-value="workshop">{jobs.length}</strong>
      </Link>}
      {finance&&<Link href="/cobros" className={`business-metric ${styles.metric} ${styles.orange}`}>
        <div className={styles.metricTop}><span>Saldo por cobrar</span><Wallet size={21}/></div>
        <strong data-value="receivable">{receivables?money(receivables.balance):'—'}</strong>
      </Link>}
    </div>
    {finance&&<ReadStatus reading={documents} label="los saldos por cobrar"/>}
    {vehicles&&<ReadStatus reading={blocks} label="los bloqueos de flota"/>}

    <div className={`${styles.mainGrid} ${finance&&vehicles&&ordersAccess?styles.fullOverview:''}`}>
      {finance&&<section className={`${styles.panel} ${styles.cashPanel}`} aria-labelledby="cash-heading">
        <SectionHeading id="cash-heading" title="El movimiento de tu caja" description="Dinero registrado, no presupuestos ni ventas por cobrar."
          action={<Link href={`/libro-diario/?desde=${period.from}&hasta=${period.to}`}>Ver diario <ArrowUpRight size={16}/></Link>}/>
        <div className={styles.periods} role="group" aria-label="Período de caja">
          {([['week','7 días'],['month','Este mes'],['custom','Personalizado']] as const).map(([value,label])=>
            <button type="button" key={value} aria-pressed={choice===value} onClick={()=>{
              if(value==='custom'){setCustom(period);setDraft(period);}setChoice(value);
            }}>{label}</button>)}
        </div>
        {choice==='custom'&&<form className={styles.customPeriod} onSubmit={event=>{
          event.preventDefault();if(validDashboardPeriod(draft,today))setCustom(draft);
        }}>
          <label>Desde<input type="date" required value={draft.from} max={today} onChange={event=>setDraft({...draft,from:event.target.value})}/></label>
          <label>Hasta<input type="date" required value={draft.to} min={draft.from} max={today} onChange={event=>setDraft({...draft,to:event.target.value})}/></label>
          <Button variant="outline" type="submit" disabled={!validDashboardPeriod(draft,today)}>Aplicar</Button>
          <p className={!validDashboardPeriod(draft,today)?styles.invalid:undefined}>Máximo 366 días, sin fechas futuras.</p>
        </form>}
        <p className={styles.periodLabel}>{dateLabel(period.from)} — {dateLabel(period.to)}
          <span> · {cashSeries?.granularity??'Diaria'} · USD</span></p>
        <div className={styles.cashTotals} aria-label="Totales del período de caja">
          <div><span><ArrowDownLeft size={15}/>Entradas</span><strong data-value="income">{cashSeries?money(cashSeries.income):'—'}</strong></div>
          <div><span><ArrowUpRight size={15}/>Salidas</span><strong data-value="outgoing">{cashSeries?money(cashSeries.outgoing):'—'}</strong></div>
          <div><span>Movimiento neto</span><strong data-value="net">{cashSeries?money(cashSeries.net):'—'}</strong></div>
        </div>
        <div className={styles.cashChart}>
          {cashSeries&&(cashSeries.income!==0||cashSeries.outgoing!==0)?<Chart option={cashOption}
            label={`Entradas y salidas de caja. ${dateLabel(period.from)} al ${dateLabel(period.to)}. Valores en dólares.`}/>:
            <div className={styles.empty} role="status"><Wallet size={28}/><strong>{cashSeries?'Sin entradas ni salidas en este período':cash.error?'Caja no disponible':'Consultando el libro diario…'}</strong>
              <p>{cashSeries?'Selecciona otro período o revisa el Libro diario. No se agregan cifras de ejemplo.':'Los importes aparecerán cuando termine la lectura.'}</p></div>}
        </div>
        <div className={styles.chartLegend}><span><i className={styles.incomeDot}/>Entradas</span><span><i className={styles.outgoingDot}/>Salidas</span>
        </div>
        <ReadStatus reading={cash} label="la caja"/>
        {!!cash.value?.unassignedRefunds&&<p className={styles.reconciliation}>{cash.value.unassignedRefunds} reembolsos con cuenta pendiente de conciliar.</p>}
        {cashSeries&&<details className={styles.dataDetails}><summary>Ver valores de la gráfica</summary>
          <p className={styles.note}><Info size={15}/>Entradas menos salidas. No representa utilidad ni saldo bancario.
            {cash.updatedAt&&` Lectura: ${timeLabel(cash.updatedAt)}.`}</p>
          <ul>{cashSeries.points.map(point=><li key={point.from}><span>{dateLabel(point.from)}{point.to!==point.from&&` — ${dateLabel(point.to)}`}</span>
            <span>Entradas <b>{money(point.inflow)}</b></span><span>Salidas <b>{money(point.outflow)}</b></span>
            <Link href={`/libro-diario/?desde=${point.from}&hasta=${point.to}`}>Ver movimientos <ArrowRight size={14}/></Link></li>)}</ul>
        </details>}
      </section>}

      {vehicles&&<section id="flota" className={`${styles.panel} ${styles.fleetPanel}`} aria-labelledby="fleet-heading">
        <SectionHeading id="fleet-heading" title="Tu flota, de un vistazo" description="Solo vehículos de alquiler. Cada carro se cuenta una vez."
          action={<Link href="/vehiculos" aria-label="Ver toda la flota"><ArrowUpRight size={19}/></Link>}/>
        <div className={styles.fleetOverview}><div className={styles.fleetChart}>
          {groups&&fleet.length>0?<><Chart option={fleetOption} label={`Distribución actual de ${fleet.length} vehículos de alquiler.`}
            onSelect={name=>setFleetFilter(groups.find(group=>fleetLabels[group.name]===name)?.name)}/>
            <div className={styles.donutCenter} aria-hidden="true"><strong>{fleet.length}</strong><span>vehículos</span></div></>:
            <div className={styles.empty}><CarFront size={28}/><strong>{groups?'No hay vehículos en la flota':blocks.error?'Flota no disponible':'Comprobando flota…'}</strong></div>}
        </div>
        {groups&&<div className={styles.fleetLegend} aria-label="Detalle por estado de la flota">{groups.map(group=>
          <button key={group.name} type="button" aria-pressed={fleetFilter===group.name} onClick={()=>setFleetFilter(fleetFilter===group.name?undefined:group.name)}>
            <i style={{background:fleetColors[group.name]}}/><span>{fleetLabels[group.name]}</span><strong>{group.vehicles.length}</strong><ArrowRight size={14}/></button>)}</div>}</div>
          {groups&&fleetFilter&&<div className={styles.fleetSelection}><h3>{fleetLabels[fleetFilter]} · {selectedCars.length}</h3>
            {selectedCars.length?selectedCars.slice(0,4).map(vehicle=><Link key={vehicle.id} href={vehicleHref(vehicle.id)}>
              <span><strong>{vehicle.plate||'Sin placa'}</strong><small>{vehicle.brand} {vehicle.model}</small></span><ArrowUpRight size={15}/></Link>):<p>No hay vehículos en este estado.</p>}
            {selectedCars.length>4&&<Link href="/vehiculos">Ver flota completa <ArrowRight size={14}/></Link>}
          </div>}
        <details className={styles.dataDetails}><summary>Cómo se clasifica la flota</summary>
          <p className={styles.note}>Solo flota de alquiler; cada carro se cuenta una vez. Reservados incluye compromisos futuros.
            Bloqueados incluye limpieza, uso interno y datos por confirmar.</p></details>
      </section>}

      <section className={`${styles.panel} ${styles.attentionPanel}`} aria-labelledby="attention-heading">
        <SectionHeading id="attention-heading" title="Requiere atención" description="Pendientes reales, para que sepas por dónde empezar."
          action={<span className={styles.attentionCount}>{alerts.reduce((sum,alert)=>sum+alert.count,0)}</span>}/>
        {(finance&&!documents.value)||(vehicles&&!blocks.value)?<p className={styles.pendingNote}>Falta completar la lectura de {finance&&!documents.value?'saldos':'flota'}. La lista puede estar incompleta.</p>:null}
        <div className={styles.alerts}>{alerts.map(alert=><Link key={alert.key} href={alert.href} className={alert.urgent?styles.urgent:undefined}
          title={alert.detail} aria-label={`${alert.title}: ${alert.count}. ${alert.detail}`}>
          <span className={styles.alertIcon}>{alert.urgent?<TriangleAlert size={19}/>:alert.key==='quotes'?<FileText size={19}/>:<Clock3 size={19}/>}</span>
          <div><strong>{alert.title} <b>{alert.count}</b></strong></div><ArrowUpRight size={16}/></Link>)}</div>
        {!alerts.length&&<div className={styles.empty}><CircleCheck size={30}/><strong>No hay alertas en los datos consultados.</strong><p>Los pendientes se muestran según tus permisos.</p></div>}
      </section>

      {ordersAccess&&<section className={`${styles.panel} ${styles.workshopPanel}`} aria-labelledby="workshop-heading">
        <SectionHeading id="workshop-heading" title="¿Cómo va el taller?" description="Trabajos recibidos físicamente y todavía no entregados."
          action={<Link href="/taller">Ver taller <ArrowUpRight size={16}/></Link>}/>
        <div className={styles.workshopToolbar}><span><strong>{filteredJobs.length}</strong> trabajos en curso</span><label>Área del taller
          <select aria-label="Área del taller" value={area} onChange={event=>{setArea(event.target.value);setStageFilter('');}}><option>Todas</option><option>Mecánica</option><option>Pintura</option></select></label></div>
        {filteredJobs.length?<div className={styles.workshopChart}><Chart option={workshopOption} label={`Trabajos por etapa. Área: ${area}.`}
          onSelect={name=>{setStageFilter(stageFilter===name?'':name);setShowJobs(true);}}/></div>:<div className={styles.empty}><Wrench size={28}/><strong>No hay trabajos recibidos en esta área.</strong></div>}
        <div className={styles.stages} aria-label="Filtrar trabajos por etapa">{stages.map(stage=>
          <button key={stage.name} type="button" aria-pressed={stageFilter===stage.name} onClick={()=>{setStageFilter(stageFilter===stage.name?'':stage.name);setShowJobs(true);}}>
            {stage.name} <b>{stage.count}</b></button>)}</div>
        <details className={styles.dataDetails} open={showJobs} onToggle={event=>setShowJobs(event.currentTarget.open)}>
          <summary>Ver trabajos ({visibleJobs.length})</summary>
        <div className={styles.jobList}>{visibleJobs.slice(0,3).map(job=><Link key={job.id} href={orderHref(job.id)}>
          <span className={styles.jobIcon}><Wrench size={17}/></span><div><strong>{data.vehicles.find(vehicle=>vehicle.id===job.vehicleId)?.plate||'Sin placa'} <small>· {job.id}</small></strong>
            <p>{job.service}</p><span>{job.area} · {job.status}</span></div><ArrowUpRight size={16}/></Link>)}
          {!visibleJobs.length&&stageFilter&&<p className={styles.listEmpty}>Sin trabajos en esta etapa.</p>}</div>
        {visibleJobs.length>3&&<p className={styles.note}>Se muestran 3 de {visibleJobs.length} trabajos. El detalle completo está en Taller.</p>}
        </details>
      </section>}

      {ordersAccess&&<section className={`${styles.panel} ${styles.agendaPanel}`} aria-labelledby="agenda-heading">
        <SectionHeading id="agenda-heading" title="Lo que viene" description="Entregas y devoluciones previstas para los próximos 7 días."
          action={<Link href="/calendario">Ver calendario <ArrowUpRight size={16}/></Link>}/>
        {rentals.agenda.length?<div className={styles.agenda}>{rentals.agenda.slice(0,3).map(event=>{
          const reservation=event.reservation,vehicle=data.vehicles.find(car=>car.id===reservation.vehicleId);
          const when=new Date(event.at);
          return <Link key={event.id} href={rentalHref(reservation.id)}
            className={event.kind==='Devolución'?styles.returnCard:undefined}>
            <div className={styles.agendaDate}><strong>{when.toLocaleDateString('es-SV',{day:'2-digit',timeZone:'America/El_Salvador'})}</strong>
              <span>{when.toLocaleDateString('es-SV',{month:'short',timeZone:'America/El_Salvador'})}</span></div>
            <div><span className={`${styles.eventKind} ${event.kind==='Devolución'?styles.return:styles.departure}`}>{event.kind} prevista</span>
              <strong>{vehicle?.plate||'Sin placa'} <small>· {folio('ALQ',reservation.folioNumber)}</small></strong>
              <p>{data.customers.find(customer=>customer.id===reservation.customerId)?.name||'Cliente del contrato'}</p>
              <span className={styles.eventTime}><Clock3 size={13}/>{timeLabel(when)} · El Salvador</span></div><ArrowUpRight size={17}/>
          </Link>;
        })}</div>:<div className={styles.empty}><CalendarDays size={28}/><strong>No hay entregas ni devoluciones próximas.</strong><p>Los alquileres abiertos sin fecha final no tienen devolución prevista.</p></div>}
        {rentals.agenda.length>3&&<p className={styles.note}>Se muestran los 3 movimientos más próximos de {rentals.agenda.length}. Consulta el resto en Calendario.</p>}
      </section>}
    </div>
    {!ordersAccess&&can('tasks.read')&&<section className={styles.panel}><SectionHeading id="tasks-heading" title="Mis tareas" description="Tu trabajo pendiente en taller."/>
      <p className={styles.note}>{data.tasks?.filter(task=>task.status!=='Finalizada').length??0} tareas pendientes <Link href="/tareas">Abrir mis tareas →</Link></p></section>}
  </div>;
}
