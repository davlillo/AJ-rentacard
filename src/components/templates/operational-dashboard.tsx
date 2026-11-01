'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {ArrowRight,CarFront,Wallet,Wrench,CalendarDays,Plus} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {fleetStatus} from '@/controladores/fleet-status';
import {localToday,loadBilling,type Receivable} from '@/lib/supabase/billing';
import {loadDiary,type CashDiary} from '@/lib/supabase/diary';
import {orderHref,rentalHref} from '@/lib/supabase/cases';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';

export function OperationalDashboard(){
  const {data,can,open}=useBusiness();const finance=can('expenses.read');const today=localToday();
  const [diary,setDiary]=useState<CashDiary>();const [documents,setDocuments]=useState<Receivable[]>();const [error,setError]=useState('');
  useEffect(()=>{let active=true;if(finance)void Promise.all([loadDiary(today.slice(0,8)+'01',today),loadBilling(today)]).then(([cash,billing])=>{
    if(active){setDiary(cash);setDocuments(billing.documents);setError('');}
  }).catch(()=>{if(active)setError('No se pudo actualizar el resumen financiero.');});return()=>{active=false;};},[finance,today,data.movements]);
  const fleet=data.vehicles.filter(v=>v.inRentalFleet);const history=data.reservationHistory??[];
  const available=fleet.filter(v=>fleetStatus(v,history)==='Disponible').length;
  const rented=fleet.filter(v=>v.status==='Alquilado').length;const reserved=fleet.filter(v=>fleetStatus(v,history)==='Reservado').length;
  const orders=data.orders.filter(o=>o.status!=='Entregado'&&o.status!=='Presupuesto');
  const upcoming=history.filter(r=>r.status==='Confirmada'&&r.rentalState==='Preparado'&&Date.parse(r.start)>=Date.parse(today+'T00:00:00-06:00'))
    .sort((a,b)=>a.start.localeCompare(b.start));
  const outstanding=documents?.reduce((sum,d)=>sum+Number(d.balance),0);
  const days=Array.from({length:7},(_,i)=>new Date(Date.parse(today+'T12:00:00Z')-(6-i)*86400000).toISOString().slice(0,10));
  const chart=days.map(day=>({day,inflow:(diary?.rows??[]).filter(r=>r.date===day).reduce((s,r)=>s+Number(r.inflow),0),
    outflow:(diary?.rows??[]).filter(r=>r.date===day).reduce((s,r)=>s+Number(r.outflow),0)}));
  const maximum=Math.max(1,...chart.flatMap(p=>[p.inflow,p.outflow]));
  return <div className="business-dashboard"><PageHeading title="Resumen del negocio" description="Lo que necesita tu atención hoy."
    actions={can('orders.write')?<Button onClick={()=>open('orden')}><Plus size={16}/>Nueva entrada al taller</Button>:undefined}/>
    <div className="business-metrics">
      {can('vehicles.read')&&<Link href="/vehiculos" className="business-metric"><div><span>Vehículos disponibles</span><CarFront size={19}/></div><strong>{available}<small> / {fleet.length}</small></strong><p>{rented} alquilados · {reserved} reservados</p></Link>}
      {can('orders.read')&&<Link href="/taller" className="business-metric"><div><span>Trabajos en taller</span><Wrench size={19}/></div><strong>{orders.length}</strong><p>{orders.filter(o=>o.area==='Mecánica').length} mecánica · {orders.filter(o=>o.area==='Pintura').length} pintura</p></Link>}
      {finance&&<Link href="/cobros" className="business-metric"><div><span>Pendiente de cobro</span><Wallet size={19}/></div><strong>{outstanding===undefined?'—':money(outstanding)}</strong><p>{documents?`${documents.filter(d=>d.balance>0).length} documentos pendientes`:'Cargando saldos…'}</p></Link>}
      {can('orders.read')&&<Link href="/calendario" className="business-metric"><div><span>Próximas entregas</span><CalendarDays size={19}/></div><strong>{upcoming.length}</strong><p>Reservas confirmadas</p></Link>}
    </div>
    <div className="dashboard-main-grid">
      {finance&&<section className="panel dashboard-finance"><div className="business-section-heading"><div><h2>Entradas y salidas</h2><p>Movimientos de caja del mes</p></div><Link href="/libro-diario">Ver diario <ArrowRight size={14}/></Link></div>
        <div className="finance-summary"><div><span>Entradas</span><strong>{diary?money(diary.income):'—'}</strong></div><div><span>Salidas</span><strong>{diary?money(diary.outgoing):'—'}</strong></div><div><span>Movimiento neto</span><strong>{diary?money(diary.netMovement):'—'}</strong></div></div>
        <div className="cash-chart" role="img" aria-label="Entradas y salidas registradas en los últimos siete días">{chart.map(p=><div className="cash-chart-day" key={p.day}>
          <div className="cash-chart-bars"><i title={`Entradas ${money(p.inflow)}`} style={{height:`${p.inflow/maximum*100}%`}}/><i title={`Salidas ${money(p.outflow)}`} style={{height:`${p.outflow/maximum*100}%`}}/></div>
          <span>{p.day.slice(8)}/{p.day.slice(5,7)}</span></div>)}</div><div className="cash-chart-legend"><span>● Entradas</span><span>● Salidas</span></div>
      </section>}
      {can('vehicles.read')&&<section className="panel"><div className="business-section-heading"><div><h2>Estado de la flota</h2><p>{fleet.length} vehículos en total</p></div><Link href="/vehiculos" aria-label="Ver flota"><ArrowRight size={16}/></Link></div>
        <div className="fleet-overview">{[['Disponibles',available,'#237b5b'],['Alquilados',rented,'#3b6baf'],['Reservados',reserved,'#b08132'],['En taller',fleet.filter(v=>v.status==='En taller').length,'#8c6970'],['Por confirmar',fleet.filter(v=>v.status==='Por confirmar').length,'#8b95a4']].map(([label,value,color])=>
          <div key={String(label)}><span><i style={{background:String(color)}}/>{label}</span><strong>{value}</strong><div><i style={{width:`${fleet.length?Number(value)/fleet.length*100:0}%`,background:String(color)}}/></div></div>)}</div>
      </section>}
    </div>
    <div className="dashboard-main-grid">
      {can('orders.read')&&<section className="panel"><div className="business-section-heading"><h2>Trabajos en curso</h2><Link href="/taller">Ver taller <ArrowRight size={14}/></Link></div>
        {orders.length?<div className="table-scroll"><AdaptiveTable><thead><tr><th>Vehículo / trabajo</th><th>Área</th><th>Estado</th><th/></tr></thead><tbody>{orders.slice(0,5).map(o=><tr key={o.id}>
          <td><strong>{data.vehicles.find(v=>v.id===o.vehicleId)?.plate||'Sin placa'}</strong><small>{o.service}</small></td><td>{o.area}</td><td>{o.status}</td><td><Link className="text-link" href={orderHref(o.id)}>Abrir →</Link></td></tr>)}</tbody></AdaptiveTable></div>:<p className="module-empty">No hay vehículos recibidos en taller. <Link className="text-link" href="/presupuestos">Ver presupuestos →</Link></p>}
      </section>}
      {can('orders.read')&&<section className="panel"><div className="business-section-heading"><h2>Próximas reservas</h2><Link href="/calendario">Ver calendario <ArrowRight size={14}/></Link></div>
        {upcoming.length?<div className="dashboard-agenda">{upcoming.slice(0,5).map(r=><Link key={r.id} href={rentalHref(r.id)}><span className="agenda-date">{new Date(r.start).toLocaleDateString('es-SV',{day:'2-digit',month:'short',timeZone:'America/El_Salvador'})}</span>
          <div><strong>{data.vehicles.find(v=>v.id===r.vehicleId)?.plate}</strong><p>{data.customers.find(c=>c.id===r.customerId)?.name??'Cliente'}</p></div><ArrowRight size={15}/></Link>)}</div>:<p className="module-empty">No hay entregas próximas.</p>}
      </section>}
    </div>
    {!can('orders.read')&&can('tasks.read')&&<section className="panel p-5"><h2 className="font-semibold">Mis tareas</h2><p className="mt-2">{data.tasks?.filter(t=>t.status!=='Finalizada').length??0} tareas pendientes</p><Link className="text-link mt-4" href="/tareas">Abrir mis tareas →</Link></section>}
    {error&&<p role="alert" className="form-error">{error}</p>}
  </div>;
}
