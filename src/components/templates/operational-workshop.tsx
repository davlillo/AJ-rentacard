'use client';
import {useState} from 'react';
import Link from 'next/link';
import {Plus,Search} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {TallerScreen} from './taller-screen';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {Badge,statusTone} from '@/components/atoms/badge';
import {TaskBoard} from '@/components/organisms/task-board';
import {orderHref,vehicleHref} from '@/lib/supabase/cases';
import {folio} from '@/controladores/folios';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';
import {Pagination,usePagination} from '@/components/organisms/pagination';

export function WorkshopScreen(){const {source}=useBusiness();return source==='supabase'?<WorkshopWorkspace/>:<TallerScreen/>;}
function WorkshopWorkspace(){
  const {data,open,can}=useBusiness();const [tab,setTab]=useState('Todos los trabajos');const [query,setQuery]=useState('');
  const [status,setStatus]=useState('En curso');const [taskJob,setTaskJob]=useState('');
  const jobs=data.orders.filter(o=>(tab==='Todos los trabajos'||tab==='Tareas'||o.area===tab)&&
    (status==='Todos'||(status==='Entregados'?o.status==='Entregado':status==='Por recibir'?o.status==='Presupuesto':o.status!=='Entregado'&&o.status!=='Presupuesto'))&&
    `${o.id} ${o.service} ${data.vehicles.find(v=>v.id===o.vehicleId)?.plate} ${data.customers.find(c=>c.id===o.customerId)?.name??''}`.toLowerCase().includes(query.toLowerCase()));
  const page=usePagination(jobs,tab+status+query);
  return <><PageHeading title="Taller" description="Ingresos, mecánica, pintura y tareas en un solo lugar."
    actions={<Button disabled={!can('orders.write')} onClick={()=>open('orden')}><Plus size={16}/>Nueva entrada</Button>}/>
    <nav className="module-tabs" aria-label="Áreas del taller">{['Todos los trabajos','Mecánica','Pintura','Tareas'].map(t=>
      <button key={t} className={tab===t?'active':''} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t}</button>)}</nav>
    {tab==='Tareas'?<section className="panel p-5"><label className="form-field mb-5"><span>Trabajo de taller</span><select aria-label="Trabajo para las tareas" value={taskJob} onChange={e=>setTaskJob(e.target.value)}>
      <option value="">Todas las tareas</option>{data.orders.filter(o=>o.status!=='Entregado').map(o=><option value={o.id} key={o.id}>{data.vehicles.find(v=>v.id===o.vehicleId)?.plate} · {o.service}</option>)}</select></label>
      <TaskBoard key={taskJob} orderId={taskJob||undefined}/></section>:<>
      <div className="quote-list-tools"><div className="search-field"><Search size={15}/><input aria-label="Buscar trabajo de taller" placeholder="Buscar placa, cliente o trabajo" value={query} onChange={e=>setQuery(e.target.value)}/></div>
        <select aria-label="Estado de los trabajos" value={status} onChange={e=>setStatus(e.target.value)} className="border border-border rounded-md p-2 text-xs"><option>En curso</option><option>Por recibir</option><option>Entregados</option><option>Todos</option></select></div>
      <section className="panel"><div className="table-scroll"><AdaptiveTable><thead><tr><th>Vehículo</th><th>Trabajo / cliente</th><th>Área</th><th>Ingreso</th><th>Estado</th><th/></tr></thead>
        <tbody>{page.items.map(o=>{const car=data.vehicles.find(v=>v.id===o.vehicleId);return <tr key={o.id}>
          <td><Link href={vehicleHref(o.vehicleId)}><strong>{car?.plate||'Sin placa'}</strong><small>{car?.brand} {car?.model}</small></Link></td>
          <td><Link className="folio-link" href={orderHref(o.id)}>{folio('OT',o.id)}</Link><strong>{o.service}</strong><small>{o.internalJob?'Mantenimiento interno':data.customers.find(c=>c.id===o.customerId)?.name}</small></td>
          <td>{o.area}</td><td>{o.status==='Presupuesto'?'Sin recepción':o.occurredAt?new Date(o.occurredAt).toLocaleDateString('es-SV',{timeZone:'America/El_Salvador'}):'—'}</td>
          <td><Badge tone={statusTone(o.status)}>{o.status}</Badge>{!!o.pendingFields?.length&&<small>Recepción por completar</small>}</td>
          <td><Button variant="outline" size="sm" asChild><Link href={orderHref(o.id)}>Ver trabajo</Link></Button></td></tr>;})}</tbody></AdaptiveTable></div>
        {!jobs.length&&<p className="module-empty">No hay trabajos en esta vista.</p>}<Pagination {...page}/></section>
    </>}
    <details className="mt-6 text-sm"><summary className="muted">Vehículos de clientes del taller</summary><section className="panel mt-4"><div className="table-scroll"><AdaptiveTable><thead><tr><th>Placa</th><th>Vehículo</th><th/></tr></thead><tbody>
      {data.vehicles.filter(v=>!v.inRentalFleet).map(v=><tr key={v.id}><td>{v.plate||'Sin registrar'}</td><td>{v.brand} {v.model}</td><td><Link className="text-link" href={vehicleHref(v.id)}>Ver expediente →</Link></td></tr>)}</tbody></AdaptiveTable></div>
      <div className="p-4"><Button variant="outline" disabled={!can('vehicles.write')} onClick={()=>open('vehiculo','client')}>Registrar vehículo de cliente</Button></div></section></details>
  </>;
}
