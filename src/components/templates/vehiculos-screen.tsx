'use client';
import Link from 'next/link';
import {useState,useEffect} from 'react';
import {Plus,ArrowUpRight,Gauge,CarFront} from 'lucide-react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Empty} from '@/components/organisms/data-table';
import {Button} from '@/components/ui/button';
import {Badge,statusTone} from '@/components/atoms/badge';
import {VehicleArt} from '@/components/atoms/vehicle-art';
import {VehicleImage} from '@/components/organisms/vehicle-image';
import {VehicleDetail} from '@/components/organisms/vehicle-detail';
import {vehicleHref} from '@/lib/supabase/cases';
import {money} from '@/controladores/finanzas';
import {fleetStatus,type FleetStatus} from '@/controladores/fleet-status';
import {Pagination,usePagination} from '@/components/organisms/pagination';

export function VehiculosScreen(){
  const {data,open,source,can}=useBusiness();const [query,setQuery]=useState('');
  const [status,setStatus]=useState<'Todos'|FleetStatus>('Todos');const [detail,setDetail]=useState<string|null>(null);
  useEffect(()=>{setQuery(new URLSearchParams(window.location.search).get('buscar')||'');},[]);
  const fleet=data.vehicles.filter(v=>source==='demo'||v.inRentalFleet);
  const reservations=source==='supabase'?data.reservationHistory??[]:data.rentals.map(r=>({
    id:r.id,vehicleId:r.vehicleId,customerId:r.customerId,start:r.start,end:r.end,status:r.status,rentalState:'Preparado'}));
  const states=new Map(fleet.map(vehicle=>[vehicle.id,fleetStatus(vehicle,reservations)]));
  const vehicles=fleet.filter(v=>`${v.brand} ${v.model} ${v.plate} ${v.commercialLine??''}`
    .toLowerCase().includes(query.toLowerCase())&&(status==='Todos'||status===states.get(v.id)))
    .sort((a,b)=>(a.commercialLine??'').localeCompare(b.commercialLine??'','es')||a.plate.localeCompare(b.plate));
  const page=usePagination(vehicles,query+status,12);
  return <>
    <PageHeading title="Vehículos" description="Tu flota de alquiler."
      actions={<Button disabled={!can('vehicles.write')} onClick={()=>open('vehiculo')}><Plus size={16}/>Agregar vehículo</Button>}/>
    <div className="vehicle-toolbar"><div className="tabs" role="tablist" aria-label="Estado de la flota">
      {([['Todos','Toda la flota'],['Disponible','Disponibles'],['Alquilado','Alquilados'],['Reservado','Reservados']] as const)
        .map(([value,label])=><button role="tab" aria-selected={status===value} className={status===value?'active':''}
        key={value} onClick={()=>setStatus(value)}>{label}<span>
          {value==='Todos'?fleet.length:fleet.filter(v=>states.get(v.id)===value).length}</span></button>)}
    </div><div className="search-field"><CarFront size={16}/><input aria-label="Buscar vehículo"
      placeholder="Buscar placa, modelo o línea..." value={query} onChange={e=>setQuery(e.target.value)}/></div></div>
    <div className="vehicle-grid">{page.items.map(v=><article className="vehicle-card" key={v.id}>
      {source==='supabase'?<VehicleImage vehicleId={v.id} plate={v.plate} fileId={v.primaryPhotoId} editable/>:
        <div className="vehicle-image"><VehicleArt color={v.color} category={v.category} model={`${v.brand} ${v.model}`}/></div>}
      <div className="vehicle-card-top"><span className="vehicle-category">{v.commercialLine||v.category}</span>
        <Badge tone={states.get(v.id)==='Reservado'?'amber':statusTone(v.status)}>{states.get(v.id)}</Badge></div>
      <div className="vehicle-card-info"><div><h2>{v.brand} {v.model}</h2><span>{v.year}{v.color?' · '+v.color:''}</span></div>
        <span className="plate">{v.plate||'Sin placa'}</span></div>
      <div className="vehicle-facts"><span><Gauge size={14}/>{v.unverified_fields?.includes('km')?'Kilometraje pendiente':`${v.km.toLocaleString()} km`}</span>
        <span>Titular: {v.registeredHolder||'Sin registrar'}</span></div>
      <div className="vehicle-card-footer"><div>{v.unverified_fields?.includes('daily')?<span className="muted text-xs">Tarifa pendiente</span>:<><strong>{money(v.daily)}</strong><small>/ día</small></>}</div>
        {source==='supabase'?<Button asChild variant="outline" size="sm"><Link href={vehicleHref(v.id)}>
          Ver expediente<ArrowUpRight size={14}/></Link></Button>:<Button variant="outline" size="sm"
          onClick={()=>setDetail(v.id)}>Ver expediente<ArrowUpRight size={14}/></Button>}</div>
    </article>)}</div>{!vehicles.length&&<Empty/>}<Pagination {...page}/>
    {source==='supabase'&&<p className="screen-note"><Link href="/calendario">Ver disponibilidad por fecha en Calendario →</Link></p>}
    {source==='demo'&&<VehicleDetail id={detail} onClose={()=>setDetail(null)}/>}
  </>;
}
