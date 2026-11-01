'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useBusiness} from '@/hooks/use-business';
import {Button} from '@/components/ui/button';
import {OperationalDashboard} from './operational-dashboard';

const permissions: Record<string, string> = {
  '/clientes': 'customers.read', '/vehiculos': 'vehicles.read', '/taller': 'orders.read',
  '/libro-diario': 'expenses.read',
  '/tareas': 'tasks.read',
  '/presupuestos': 'expenses.write',
  '/calendario': 'orders.read',
  '/cobros': 'expenses.read',
  '/inventario': 'expenses.read',
  '/reportes': 'expenses.read',
  '/asistente': 'expenses.read',
  '/configuracion': 'administration.write',
  '/vehiculos/expediente': 'vehicles.read', '/taller/ingreso': 'orders.read',
  '/vehiculos/reservas': 'orders.read', '/vehiculos/bloqueos': 'orders.read',
  '/archivos': 'expenses.read',
  '/vehiculos/alquiler': 'orders.read',
};

export function OperationalRouteGate({children}: {children: React.ReactNode}) {
  const {source, can} = useBusiness();
  const pathname = usePathname().replace(/\/$/, '') || '/';
  if (source === 'demo') return children;
  if (pathname === '/' || pathname === '/inicio') return <OperationalDashboard/>;
  const permission = permissions[pathname];
  if (!permission) return <section className="panel p-6"><h1 className="text-xl font-semibold">Historia pendiente</h1>
    <p className="mt-3">Este módulo todavía pertenece al prototipo. No se permiten acciones ficticias en el modo operativo.</p>
    <Button asChild variant="outline" className="mt-4"><Link href="/inicio">Volver al inicio</Link></Button>
  </section>;
  if (!can(permission)) return <section className="panel p-6" role="alert"><h1 className="text-xl font-semibold">Acceso restringido</h1>
    <p className="mt-3">Tu usuario no tiene permiso para consultar este módulo.</p></section>;
  return children;
}
