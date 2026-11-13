import type {Reservation,Commitment} from '../lib/supabase/reservations';

const zone='America/El_Salvador';
export const rentalSections=['Resumen','Salida y devolución','Cargos y abonos','Limpieza','Gastos','Fotos y documentos','Contrato'] as const;
export type RentalSection=typeof rentalSections[number];
export interface RentalWorkflow {
  label:string;tone:string;step:number|null;action:'confirm'|'depart'|'return'|'clean'|null;description:string;
}

export function rentalDateTime(value:string):string{
  if(value==='infinity')return 'Sin fecha final definida';
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return 'Fecha por revisar';
  return `${date.toLocaleDateString('es-SV',{day:'numeric',month:'short',year:'numeric',timeZone:zone})} · ${date.toLocaleTimeString('es-SV',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:zone})}`;
}

export function rentalSection(value:string|null):RentalSection{
  if(value==='Períodos y abonos')return 'Cargos y abonos';
  return rentalSections.find(section=>section===value)??'Resumen';
}
export function rentalSectionHref(id:string,section:RentalSection='Resumen'):string{
  return `/vehiculos/alquiler/?${new URLSearchParams({id,seccion:section})}`;
}

export function rentalWorkflow(booking:Reservation,commitments:Commitment[]):RentalWorkflow{
  if(booking.status==='Cancelada')return{label:'Reserva cancelada',tone:'gray',step:null,action:null,
    description:'La cancelación no elimina cargos ni devuelve pagos automáticamente.'};
  if(booking.status==='Borrador')return{label:'Reserva sin confirmar',tone:'gray',step:0,action:'confirm',
    description:'Confirme la reserva para bloquear sus fechas. El vehículo todavía no se ha entregado.'};
  if(booking.rental_state==='Preparado')return{label:'Reserva confirmada',tone:'amber',step:0,action:'depart',
    description:'El vehículo está reservado, pero aún no se ha entregado al cliente.'};
  if(booking.rental_state==='Entregado')return{label:'Alquiler en curso',tone:'blue',step:1,action:'return',
    description:'El cliente tiene el vehículo. Registre la devolución cuando lo reciba.'};
  const cleaning=commitments.filter(c=>c.reservation_id===booking.id&&c.kind==='Limpieza');
  // An elapsed schedule is not evidence that the post-return cleaning was reviewed.
  const reviewed=!cleaning.some(c=>c.active)&&(booking.rental_state==='Cerrado'||cleaning.some(c=>!c.active));
  return reviewed?{label:'Alquiler finalizado',tone:'green',step:3,action:null,
    description:'Vehículo devuelto y limpieza revisada. Los saldos pendientes se cobran por separado.'}:
    {label:'Devuelto · limpieza pendiente',tone:'amber',step:2,action:'clean',
      description:'La devolución ya se registró. Revise y finalice la limpieza para liberar el vehículo.'};
}

export function groupVehicleRentals(reservations:Reservation[],commitments:Commitment[]):{
  focus:Reservation|undefined;active:Reservation[];returned:Reservation[];reserved:Reservation[];drafts:Reservation[];history:Reservation[];
}{
  const ordered=[...reservations].sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at)||a.id.localeCompare(b.id));
  const active=ordered.filter(r=>r.status==='Confirmada'&&r.rental_state==='Entregado');
  const returned=ordered.filter(r=>r.status!=='Cancelada'&&['Devuelto','Cerrado'].includes(r.rental_state)&&rentalWorkflow(r,commitments).action==='clean');
  const reserved=ordered.filter(r=>r.status==='Confirmada'&&r.rental_state==='Preparado');
  const drafts=ordered.filter(r=>r.status==='Borrador');
  const history=ordered.filter(r=>r.status==='Cancelada'||rentalWorkflow(r,commitments).step===3).reverse();
  return{focus:active[0]??returned[0]??reserved[0]??drafts[0],active,returned,reserved,drafts,history};
}
