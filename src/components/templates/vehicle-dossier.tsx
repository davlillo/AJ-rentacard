'use client';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {useSearchParams} from 'next/navigation';
import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {ArrowRight,CarFront,Check,FileText,RefreshCw,Settings2,Wallet,Wrench} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';
import {VehiclePhoto} from '@/components/atoms/vehicle-photo';
import {loadCase,loadRentalCase,orderHref,rentalHref,type CaseFile} from '@/lib/supabase/cases';
import {loadRentalInspections,type RentalInspection} from '@/lib/supabase/reservations';
import {money} from '@/controladores/finanzas';
import {folio} from '@/controladores/folios';
import {rentalDateTime,rentalWorkflow} from '@/controladores/rental-workflow';
import {VehicleReleaseReview} from '@/components/organisms/vehicle-release-review';
import {
  dossierSections,dossierSection,dossierMoney,dossierLedger,dossierFiles,documentChecklist,
  rentalRows,workshopRows,dossierDate,dossierChartOption,dossierRentalScope,
  type DossierAmounts,type DossierRentalAmounts,type DossierSection,
} from '@/controladores/vehicle-dossier';
import styles from './vehicle-dossier.module.css';

const Chart=dynamic(()=>import('@/components/organisms/dashboard-chart').then(module=>module.DashboardChart),
  {ssr:false,loading:()=> <p role="status">Preparando gráfica…</p>});
type Selection={kind:'rental'|'workshop';id:string};
const amountLabel=(amount:number|null)=>amount===null?'Sin importe registrado':money(amount);

function Amounts({value,rental}:{value:DossierAmounts|null;rental?:DossierRentalAmounts|null}){
  if(!value)return null;
  // A rental scope shows what was agreed and what is still pending; a workshop or vehicle scope
  // keeps the issued amounts, the applied money and the expenses.
  const moneyRows:[string,number|null,string][]=rental?[
    ['Lo acordado',rental.agreed,'Lo pactado con el cliente en este alquiler'],
    ['Lo pendiente',rental.pending,'Lo que el cliente todavía debe de este alquiler'],
    ['Importes emitidos al cliente',value.charged,'Documentos · no cobros en caja'],
    ['Cobros aplicados',value.paid,'Aplicaciones netas de reversiones'],
    ['Egresos vinculados',value.expenses,'Solo la parte de este alcance'],
  ]:[
    ['Importes emitidos al cliente',value.charged,'Documentos · no cobros en caja'],
    ['Cobros aplicados',value.paid,'Aplicaciones netas de reversiones'],
    ['Saldo pendiente',value.balance,'Saldo informado por el servidor'],
    ['Egresos vinculados',value.expenses,'Solo la parte de este alcance'],
  ];
  return <dl className={styles.amounts} aria-label="Importes del alcance consultado">
    {moneyRows.map(([label,amount,note])=><div key={label}><dt>{label}</dt>
      <dd>{label==='Lo acordado'&&amount===null?'Sin total acordado':amountLabel(amount)}</dd><small>{note}</small></div>)}
  </dl>;
}

function Facts({items}:{items:[string,ReactNode][]}){
  return <dl className={styles.facts}>{items.map(([label,value])=><div key={label}>
    <dt>{label}</dt><dd>{value||'Sin registro'}</dd></div>)}</dl>;
}

function Readings({readings}:{readings:{id:string;kind?:string;km:number|null;fuel:number|null;
  condition:string;accessories:string;evidence?:string}[]}){
  return <section className={styles.readings}><h3>Lecturas e inspección guardadas</h3>
    {!readings.length&&<p>Sin inspección registrada.</p>}
    {readings.map(row=><article key={row.id}><h4>{row.kind??'Recepción de taller'}</h4>
      <Facts items={[
        ['Kilometraje',row.km===null?'Sin registro':`${row.km.toLocaleString('es-SV')} km`],
        ['Combustible',row.fuel===null?'Sin registro':`${row.fuel} %`],
        ['Condición',row.condition],['Accesorios',row.accessories],
        ...(row.evidence?[['Evidencia',row.evidence] as [string,ReactNode]]:[]),
      ]}/></article>)}
  </section>;
}

function ScopedSummary({selection,vehicleId,finance,onChange}:{selection:Selection;vehicleId:string;finance:boolean;onChange:()=>Promise<void>}){
  const {data}=useBusiness();
  const [loaded,setLoaded]=useState<{file:CaseFile;inspections:RentalInspection[]}|null>(null);
  const [error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;
    setError('');
    // Grouped header IDs cannot partition vehicle totals. Read only the selected scope.
    const request=selection.kind==='rental'?
      Promise.all([loadRentalCase(selection.id),loadRentalInspections(selection.id)])
        .then(([file,review])=>({file,inspections:review.inspections})):
      loadCase(vehicleId,selection.id).then(file=>({file,inspections:[]}));
    void request.then(value=>{
      const matches=value.file.vehicle.id===vehicleId&&(selection.kind==='rental'?
        value.file.reservations.some(row=>row.id===selection.id):
        value.file.orders.some(row=>row.id===selection.id));
      if(!matches)throw new Error('El detalle no corresponde a la operación seleccionada.');
      if(active)setLoaded(value);
    }).catch(()=>{if(active)setError('No se pudo consultar este detalle. No se muestran importes del historial agregado.');});
    return()=>{active=false;};
  },[selection.id,selection.kind,vehicleId,finance,attempt]);
  if(error)return <div role="alert"><p>{error}</p>
    <Button variant="outline" onClick={()=>setAttempt(value=>value+1)}>Reintentar detalle</Button></div>;
  if(!loaded)return <p role="status">Consultando solo esta operación…</p>;
  const file=loaded.file;
  const rental=file.reservations.find(row=>row.id===selection.id);
  const order=file.orders.find(row=>row.id===selection.id);
  const amounts=dossierMoney(file,finance);
  const rentalScope=selection.kind==='rental'&&rental?dossierRentalScope(file,rental,finance):null;
  return <div data-testid="scoped-summary">
    {selection.kind==='rental'&&rental&&<>
      <Facts items={[
        ['Folio',folio('ALQ',rental.folio_number??rental.id)],
        ['Cliente',rental.customer_snapshot?.name??data.customers.find(row=>row.id===rental.customer_id)?.name],
        ['Estado de reserva',rental.status],
        ['Estado del alquiler',rentalWorkflow(rental,file.commitments).label],
        ['Inicio acordado',rentalDateTime(rental.starts_at)],['Final acordado',rentalDateTime(rental.ends_at)],
        ['Salida registrada',rental.actual_departure_at?rentalDateTime(rental.actual_departure_at):'Sin registro'],
        ['Devolución registrada',rental.actual_return_at?rentalDateTime(rental.actual_return_at):'Sin registro'],
      ]}/>
      <Readings readings={loaded.inspections}/>
      {['Devuelto','Cerrado'].includes(rental.rental_state)&&<VehicleReleaseReview file={file} booking={rental}
        onChange={async()=>{setAttempt(value=>value+1);await onChange().catch(()=>undefined);}}/>}
    </>}
    {selection.kind==='workshop'&&order&&<>
      <Facts items={[
        ['Folio',folio('OT',order.id)],['Servicio',order.service],['Estado',order.status],
        ['Cliente / destino',order.internal_job?'Mantenimiento interno':
          data.customers.find(row=>row.id===order.customer_id)?.name??'Sin acceso al cliente'],
        ['Recepción',order.status==='Presupuesto'?'Sin recepción':rentalDateTime(order.occurred_at)],
        ['Datos pendientes',order.pending_fields?.join(', ')||'Sin pendientes registrados'],
      ]}/>
      <Readings readings={order.status==='Presupuesto'?[]:file.inspections.filter(row=>row.order_id===order.id)}/>
    </>}
    <Amounts value={amounts} rental={rentalScope}/>
    {!amounts&&<p className={styles.note}>Información financiera restringida.</p>}
    <p className={styles.note}>Las consultas son de solo lectura. La confirmación de entrega y liberación del vehículo sí modifica el expediente.</p>
    <Link className={styles.link} href={selection.kind==='rental'?rentalHref(selection.id):orderHref(selection.id)}>
      {selection.kind==='rental'?'Abrir folio':'Ver trabajo'}<ArrowRight size={15}/></Link>
  </div>;
}

export function VehicleDossier({file,onChange,filesSlot,administrationSlot}:{
  file:CaseFile;onChange:()=>Promise<void>;filesSlot:ReactNode;administrationSlot:ReactNode;
}){
  const {can,open,data}=useBusiness();
  const requestedRaw=useSearchParams().get('seccion');
  // The old cleaning section of the folio now lives here: the release of a vehicle is confirmed
  // in the vehicle dossier, in the rental history.
  const requested=requestedRaw==='Limpieza'?'Alquileres':requestedRaw;
  const [section,setSection]=useState<DossierSection>(()=>dossierSection(requested));
  const [admin,setAdmin]=useState(requested==='Datos de flota');
  const [selection,setSelection]=useState<Selection|null>(null);
  const [refreshing,setRefreshing]=useState(false);
  const [error,setError]=useState('');
  const opener=useRef<HTMLElement|null>(null);
  const finance=can('expenses.read')&&file.financialAccess;
  const adminAllowed=can('vehicles.write');
  useEffect(()=>{setSection(dossierSection(requested));setAdmin(requested==='Datos de flota');},[requested]);
  useEffect(()=>{if(!adminAllowed)setAdmin(false);},[adminAllowed]);
  const car=file.vehicle;
  const rentals=rentalRows(file),jobs=workshopRows(file);
  const files=dossierFiles(file,finance);
  const checklist=documentChecklist(files);
  const amounts=dossierMoney(file,finance),ledger=dossierLedger(file,finance);
  const activity=useMemo(()=>{
    const groups=new Map<string,number>();
    for(const row of rentalRows(file)){
      const name=row.status==='Confirmada'?row.rental_state:row.status;
      groups.set(name,(groups.get(name)??0)+1);
    }
    return [...groups].map(([name,value])=>({name,value}));
  },[file]);
  const stages=useMemo(()=>{
    const groups=new Map<string,number>();
    for(const row of workshopRows(file)){
      const name=row.status==='Presupuesto'?'Sin recepción':row.status;
      groups.set(name,(groups.get(name)??0)+1);
    }
    return [...groups].map(([name,value])=>({name,value}));
  },[file]);
  const financialPoints=amounts?[
    {name:'Importes emitidos al cliente',value:amounts.charged},{name:'Cobros aplicados',value:amounts.paid},
    {name:'Saldo pendiente',value:amounts.balance},{name:'Egresos vinculados',value:amounts.expenses},
  ].filter((point):point is {name:string;value:number}=>point.value!==null):[];
  const activityOption=useMemo(()=>dossierChartOption(activity),[activity]);
  const workshopOption=useMemo(()=>dossierChartOption(stages),[stages]);
  const financialOption=dossierChartOption(financialPoints,true);
  const cover=files.filter(row=>row.mime.startsWith('image/')&&!row.financial)
    .sort((a,b)=>Number(b.purpose==='Vehículo')-Number(a.purpose==='Vehículo')||
      b.created_at.localeCompare(a.created_at))[0];
  function choose(next:DossierSection){
    setSection(next);
    const url=new URL(window.location.href);url.searchParams.set('seccion',next);
    window.history.replaceState(null,'',url);
  }
  function show(next:Selection,event:React.MouseEvent<HTMLButtonElement>){
    opener.current=event.currentTarget;setSelection(next);
  }
  function chart(title:string,points:{name:string;value:number}[],option:ReturnType<typeof dossierChartOption>){
    return <section className={styles.card}><header className={styles.cardHeader}><h2>{title}</h2>
      <span>Historial completo</span></header>
      {points.length?<><div className={styles.chart}><Chart option={option}
        label={`${title}. ${points.map(point=>`${point.name}: ${point.value}`).join('. ')}`}/></div>
        <ul className={styles.chartValues} aria-label={`Valores: ${title}`}>
          {points.map(point=><li key={point.name}><span>{point.name}</span><strong>{point.value}</strong></li>)}</ul></>:
        <p className={styles.empty}>Sin registros para esta gráfica.</p>}
    </section>;
  }
  return <div className={styles.dossier} data-testid="vehicle-dossier">
    <Link className={styles.back} href="/vehiculos">Vehículos / Expediente permanente</Link>
    <header className={styles.heading}>
      <div><p className={styles.kicker}>HISTORIA DEL VEHÍCULO</p><h1>{car.plate||'Sin placa'} <span>· {car.brand} {car.model}</span></h1>
        <p>{car.year} · {car.color||'Color sin registrar'} · {car.in_rental_fleet?'Flota de alquiler':'Vehículo de taller'}</p></div>
      <div className={styles.actions}>
        {adminAllowed&&<Button variant="outline" onClick={event=>{opener.current=event.currentTarget;setAdmin(true);}}>
          <Settings2 size={15}/>Administrar vehículo</Button>}
        <Button variant="outline" disabled={refreshing} onClick={()=>{
          setRefreshing(true);setError('');
          void onChange().catch(()=>setError('No se pudo actualizar. Se conserva la última consulta.'))
            .finally(()=>setRefreshing(false));
        }}><RefreshCw size={15}/>{refreshing?'Actualizando…':'Actualizar expediente'}</Button>
      </div>
    </header>
    <nav className={styles.tabs} aria-label="Secciones del expediente">
      {dossierSections.map(tab=><button type="button" key={tab.key} aria-pressed={section===tab.key}
        aria-controls={`dossier-${section}`} onClick={()=>choose(tab.key)}>{tab.label}</button>)}
    </nav>
    {error&&<p role="alert" className={styles.note}>{error}</p>}
    <div id={`dossier-${section}`} className={styles.section}>
      {section==='summary'&&<>
        <div className={styles.summaryTop}>
          <section className={`${styles.card} ${styles.identity}`}>
            {cover?<VehiclePhoto fileId={cover.id} plate={car.plate}/>:<CarFront size={40} aria-hidden="true"/>}
            <div><span className={styles.state}>{car.status}</span><h2>{car.brand} {car.model}</h2>
              <p>{car.unverified_fields?.includes('km')?'Kilometraje por confirmar':`${car.km.toLocaleString('es-SV')} km`}</p>
              <p>{car.registered_holder||'Titular sin registrar'}</p></div>
          </section>
          <section className={`${styles.card} ${styles.stat}`}><CarFront size={20}/><strong>{rentals.length}</strong>
            <span>Reservas y alquileres</span><button onClick={()=>choose('rentals')}>Consultar historial <ArrowRight size={14}/></button></section>
          <section className={`${styles.card} ${styles.stat}`}><Wrench size={20}/><strong>{jobs.length}</strong>
            <span>Registros de taller</span><button onClick={()=>choose('maintenance')}>Consultar historial <ArrowRight size={14}/></button></section>
        </div>
        <Amounts value={amounts}/>
        <div className={styles.chartGrid}>
          {chart('Alquileres por estado',activity,activityOption)}
          {chart('Taller por estado',stages,workshopOption)}
        </div>
        {finance&&<section className={styles.card}><header className={styles.cardHeader}><h2><Wallet size={17}/>Importes históricos del vehículo</h2>
          <button onClick={()=>choose('financial')}>Ver movimientos <ArrowRight size={14}/></button></header>
          <p className={styles.note}>Los cobros y abonos no se suman como ingreso de caja. El saldo incluye los ajustes reconocidos por el servidor.</p>
          {financialPoints.length?<div className={styles.chart}><Chart option={financialOption}
            label={`Importes históricos en USD. ${financialPoints.map(point=>`${point.name}: ${point.value}`).join('. ')}`}/></div>:
            <p className={styles.empty}>Sin importes registrados.</p>}
        </section>}
      </>}
      {section==='rentals'&&<section className={styles.card}>
        <header className={styles.cardHeader}><h2>Historial de alquileres</h2><span>{rentals.length} registros</span></header>
        {rentals.length?<table className={styles.table} aria-label="Historial de alquileres"><thead><tr>
          <th>Folio / cliente</th><th>Fechas acordadas</th><th>Estado</th><th>Consulta</th></tr></thead><tbody>
          {rentals.map(row=><tr key={row.id}><td data-label="Folio / cliente"><strong>{folio('ALQ',row.folio_number??row.id)}</strong>
            <small>{row.customer_snapshot?.name??data.customers.find(customer=>customer.id===row.customer_id)?.name??'Sin acceso al cliente'}</small></td>
            <td data-label="Fechas acordadas">{dossierDate(row.starts_at)}<small>Hasta {dossierDate(row.ends_at)}</small></td>
            <td data-label="Estado"><span className={styles.state}>{row.status}</span><small>{rentalWorkflow(row,file.commitments).label}</small></td>
            <td data-label="Consulta"><button onClick={event=>show({kind:'rental',id:row.id},event)}>Ver detalle<ArrowRight size={14}/></button></td></tr>)}
        </tbody></table>:<p className={styles.empty}>Sin reservas ni alquileres registrados.</p>}
      </section>}
      {section==='maintenance'&&<section className={styles.card}>
        <header className={styles.cardHeader}><h2>Historial de mantenimientos</h2>
          {can('orders.write')&&<Button variant="outline" disabled={!['Disponible','Por confirmar'].includes(car.status)}
            onClick={()=>open('orden',car.id)}>Nueva entrada al taller</Button>}</header>
        <p className={styles.note}>Entradas de taller internas y de clientes. Un presupuesto sin recepción no acredita mantenimiento ejecutado.</p>
        {jobs.length?<table className={styles.table} aria-label="Historial de mantenimientos"><thead><tr>
          <th>Trabajo / servicio</th><th>Recepción / origen</th><th>Estado</th><th>Consulta</th></tr></thead><tbody>
          {jobs.map(row=><tr key={row.id}><td data-label="Trabajo / servicio"><strong>{folio('OT',row.id)}</strong><small>{row.service}</small></td>
            <td data-label="Recepción / origen">{row.status==='Presupuesto'?'Sin recepción':dossierDate(row.occurred_at)}<small>{row.origin}</small></td>
            <td data-label="Estado"><span className={styles.state}>{row.status}</span></td>
            <td data-label="Consulta"><button onClick={event=>show({kind:'workshop',id:row.id},event)}>Ver detalle<ArrowRight size={14}/></button></td></tr>)}
        </tbody></table>:<p className={styles.empty}>Sin entradas de taller registradas.</p>}
      </section>}
      {section==='financial'&&(finance?<section className={styles.card}>
        <header className={styles.cardHeader}><h2>Ingresos · importes y cobros</h2>
          {can('expenses.write')&&<Button variant="outline" onClick={()=>open('gasto',`vehicle:${car.id}`)}>Registrar gasto vinculado</Button>}</header>
        <Amounts value={amounts}/>
        <p className={styles.note}>Importes del vehículo, no del comprobante completo. Abono es pago aplicado, no egreso.
          No incluye anticipos sin aplicar. Los créditos afectan el saldo; esta consulta no representa un libro completo de caja ni devoluciones.</p>
        {ledger?.length?<table className={styles.table} aria-label="Movimientos financieros del vehículo"><thead><tr>
          <th>Fecha / tipo</th><th>Concepto</th><th>Origen</th><th>Importe (USD)</th></tr></thead><tbody>
          {ledger.map(row=><tr key={row.id}><td data-label="Fecha / tipo">{dossierDate(row.date)}<small>{row.kind}</small></td>
            <td data-label="Concepto">{row.description}</td><td data-label="Origen">{row.origin}</td>
            <td data-label="Importe (USD)"><strong>{amountLabel(row.amount)}</strong></td></tr>)}
        </tbody></table>:<p className={styles.empty}>Sin importes emitidos, cobros aplicados ni egresos vinculados.</p>}
      </section>:<p className={styles.restricted}>Información financiera restringida.</p>)}
      {section==='documents'&&<>
        <section className={styles.card}><header className={styles.cardHeader}><h2><FileText size={17}/>Evidencia registrada</h2></header>
          <p className={styles.note}>Inventario por uso del archivo. No certifica vigencia, obligaciones legales ni documentación completa.</p>
          <ul className={styles.checklist}>{checklist.map(row=><li key={row.purpose}>
            {row.count?<Check size={17} aria-hidden="true"/>:<FileText size={17} aria-hidden="true"/>}
            <span>{row.purpose}</span><strong>{row.count===1?'1 archivo':row.count?`${row.count} archivos`:'Sin archivos'}</strong></li>)}</ul>
        </section>
        <div className={styles.files}>{filesSlot}</div>
      </>}
    </div>
    <Dialog open={!!selection} onOpenChange={value=>{if(!value)setSelection(null);}}>
      <DialogContent className={styles.modal} onCloseAutoFocus={event=>{event.preventDefault();opener.current?.focus();}}>
        <DialogTitle>{selection?.kind==='rental'?'Detalle del alquiler':'Detalle del mantenimiento'}</DialogTitle>
        <DialogDescription>Resumen preciso de la operación seleccionada.</DialogDescription>
        {selection&&<ScopedSummary key={`${selection.kind}:${selection.id}:${finance}`} selection={selection} vehicleId={car.id} finance={finance} onChange={onChange}/>}
      </DialogContent>
    </Dialog>
    <Dialog open={admin&&adminAllowed} onOpenChange={setAdmin}>
      <DialogContent className={styles.modal} onCloseAutoFocus={event=>{event.preventDefault();opener.current?.focus();}}>
        <DialogTitle>Administrar vehículo</DialogTitle><DialogDescription>Datos registrales y pertenencia a flota.</DialogDescription>
        {adminAllowed&&administrationSlot}
      </DialogContent>
    </Dialog>
  </div>;
}
