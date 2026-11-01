import Link from 'next/link';
export function FleetNavigation({active='Flota'}:{active?:string}){
  return <nav aria-label="Gestión de flota" className="tabs mb-5">
    {[['Flota','/vehiculos'],['Reservas','/vehiculos/reservas'],['Bloqueos','/vehiculos/bloqueos'],['Calendario','/calendario']].map(([label,href])=>
      <Link key={label} href={href} className={active===label?'active':''} aria-current={active===label?'page':undefined}>{label}</Link>)}
  </nav>;
}
