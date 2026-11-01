'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useState} from 'react';
import {CalendarDays,CarFront,Check,LayoutDashboard,Menu,Users,Wrench,BookOpen,FileText,Wallet,RefreshCw,LogOut,X} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {OperationDialog} from '@/components/organisms/operation-dialog';
import {createSupabaseBrowserClient} from '@/lib/supabase/client';

const navigation = [
  {href:'/inicio',label:'Inicio',icon:LayoutDashboard,permission:''},
  {href:'/clientes',label:'Clientes',icon:Users,permission:'customers.read'},
  {href:'/vehiculos',label:'Vehículos',icon:CarFront,permission:'vehicles.read'},
  {href:'/calendario',label:'Calendario',icon:CalendarDays,permission:'orders.read'},
  {href:'/taller',label:'Taller',icon:Wrench,permission:'orders.read'},
  {href:'/presupuestos',label:'Presupuestos',icon:FileText,permission:'expenses.write'},
  {href:'/cobros',label:'Cargos y cobros',icon:Wallet,permission:'expenses.read'},
  {href:'/libro-diario',label:'Libro diario',icon:BookOpen,permission:'expenses.read'},
];

export function OperationalShell({children}: {children: React.ReactNode}) {
  const {can,notice,refresh,toast} = useBusiness();
  const path = usePathname().replace(/\/$/, '') || '/inicio';
  const [mobile, setMobile] = useState(false);
  const items=navigation.filter(item=>!item.permission||can(item.permission)||(item.href==='/taller'&&can('tasks.read')));
  const current=navigation.find(item=>path===item.href||path.startsWith(item.href+'/'))?.label??(path==='/tareas'?'Taller':'Detalle');
  return <div className="app-shell operations-app">
    <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
      <Link href="/inicio" className="brand" onClick={() => setMobile(false)}>
        <img src="/aj-icon.svg" width="38" height="38" alt="AJ"/><span className="brand-wordmark"><strong>RENT A CAR</strong>
          <small>Administración</small></span>
      </Link>
      <nav aria-label="Navegación principal"><div className="nav-group">
        {items.map(item=>{const active=current===item.label;return <Link key={item.href}
            href={item.href==='/taller'&&!can('orders.read')?'/tareas':item.href} onClick={()=>setMobile(false)}
            aria-current={active?'page':undefined} className={`nav-item ${active?'active':''}`}><item.icon size={19}/><span>{item.label}</span></Link>;})}
      </div></nav>
      <div className="sidebar-bottom"><span>AJ Rent a Car</span><small>Rentas y taller</small></div>
    </aside>
    {mobile && <button className="mobile-overlay" aria-label="Cerrar menú" onClick={() => setMobile(false)}/>}
    <div className="app-main"><header className="topbar"><div className="breadcrumbs">
      <button className="mobile-menu" onClick={()=>setMobile(!mobile)} aria-label={mobile?'Cerrar menú':'Abrir menú'} aria-expanded={mobile}>{mobile?<X size={21}/>:<Menu size={21}/>}</button>
      <strong>{current}</strong>
    </div><div className="workspace-actions"><span className="workspace-date">{new Date().toLocaleDateString('es-SV',{day:'numeric',month:'long',year:'numeric',timeZone:'America/El_Salvador'})}</span>
      <button aria-label="Actualizar datos" onClick={()=>{void refresh().catch(()=>toast('No se pudieron actualizar los datos.'));}}><RefreshCw size={17}/></button>
      <button aria-label="Cerrar sesión" onClick={()=>{void createSupabaseBrowserClient().auth.signOut();}}><LogOut size={17}/></button></div></header>
      <main id="main-content" className="page-content">{children}</main>
    </div>
    <OperationDialog/>
    {notice && <div className="toast" role="status"><span><Check size={16}/></span>{notice}</div>}
  </div>;
}
