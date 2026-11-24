import type {Reservation,Commitment} from '../lib/supabase/reservations';

const zone='America/El_Salvador';
export const rentalSections=['Resumen','Salida y devolución','Cargos y abonos','Cuentas','Limpieza','Gastos','Fotos y documentos','Contrato'] as const;
export type RentalSection=typeof rentalSections[number];
// The folio is one ordered flow and the circles are its only navigation. The draft and the
// confirmed reservation share one agreement stage: both own the same agreement content.
export const rentalStages=['Acuerdo','Alquilado','Devolución','Cuentas','Finalizado'] as const;
export type RentalStage=typeof rentalStages[number];
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
  if(value==='Cuentas y cobros')return 'Cuentas';
  return rentalSections.find(section=>section===value)??'Resumen';
}
export function rentalSectionHref(id:string,section:RentalSection='Resumen'):string{
  return `/alquileres/folio/?${new URLSearchParams({id,seccion:section})}`;
}
// Every legacy section still resolves. It now points at the stage of the single flow that owns
// that content: the release review moved to the vehicle dossier, so the old section lands on the
// return stage, which points to the vehicle side. The old "Resumen" and "Cargos y abonos"
// sections land on the stages that own them now: the agreement and the accounts.
export function rentalSectionStage(section:RentalSection):number{
  if(section==='Salida y devolución'||section==='Limpieza')return 2;
  if(section==='Cuentas'||section==='Cargos y abonos')return 3;
  if(section==='Gastos'||section==='Fotos y documentos'||section==='Contrato')return 4;
  return 0;
}

export function isRentalPath(path:string):boolean{
  return ['/alquileres','/calendario','/vehiculos/reservas','/vehiculos/alquiler','/vehiculos/bloqueos']
    .some(root=>path===root||path.startsWith(root+'/'));
}

export const returnCleaningConflictReason='CONFLICTO de limpieza tras devolución tardía; requiere reprogramación';
export function rentalCleaningReviewable(booking:Reservation,block:Commitment):boolean{
  const returnedAt=Date.parse(booking.actual_return_at??'');const startsAt=Date.parse(block.starts_at);
  return booking.status==='Confirmada'&&booking.rental_state==='Devuelto'&&block.reservation_id===booking.id&&
    block.vehicle_id===booking.vehicle_id&&!block.order_id&&block.kind==='Limpieza'&&
    Number.isFinite(returnedAt)&&startsAt>=returnedAt&&startsAt<Date.now()&&
    (block.active||block.reason===returnCleaningConflictReason);
}

export function rentalCleaningStatus(booking:Reservation,commitments:Commitment[]):{
  cleaning:Commitment[];returned:boolean;reviewed:boolean;conflict:boolean;
}{
  const cleaning=commitments.filter(c=>c.reservation_id===booking.id&&c.kind==='Limpieza');
  const returned=booking.status==='Confirmada'&&['Devuelto','Cerrado'].includes(booking.rental_state);
  const conflict=returned&&cleaning.some(c=>/^CONFLICTO de limpieza/i.test(c.reason??''));
  // finish_block stamps an actual ending and review reason without setting Cerrado.
  const returnedAt=Date.parse(booking.actual_return_at??'');
  const reviewed=returned&&!conflict&&!cleaning.some(c=>c.active)&&(booking.rental_state==='Cerrado'||cleaning.some(c=>
    !c.active&&Boolean(c.reason?.trim())&&!['Revisión posterior a devolución','Limpieza prevista'].includes(c.reason)&&
    Number.isFinite(returnedAt)&&Date.parse(c.ends_at)>=returnedAt&&Date.parse(c.ends_at)<=Date.now()));
  return{cleaning,returned,reviewed,conflict};
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
  const {reviewed,conflict}=rentalCleaningStatus(booking,commitments);
  return reviewed?{label:'Alquiler finalizado',tone:'green',step:3,action:null,
    description:'El vehículo fue devuelto y ya está liberado. Los saldos pendientes se cobran por separado.'}:
    {label:'Devuelto · pendiente de liberar',tone:'amber',step:2,action:'clean',
       description:conflict?'Hay un compromiso de este alquiler en conflicto. Revise y reprograma el bloqueo antes de liberar el vehículo.':
         'La devolución ya se registró. La entrega y la liberación del vehículo se confirman desde el expediente del vehículo.'};
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
