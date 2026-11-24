import type {Reservation} from '../lib/supabase/reservations';

export interface RentalExtensionPreview {
  command:'extend'|'set_end';payload:Record<string,unknown>;currentEnd:string;newEnd:string;
  currentForecast:number|null;newForecast:number;difference:number|null;days:number;
}

export function rentalExtensionPreview(booking:Reservation,endsAt:string,reason:string,now=Date.now()):RentalExtensionPreview{
  const start=Date.parse(booking.starts_at);const end=Date.parse(endsAt);const previous=Date.parse(booking.ends_at);
  if(booking.status!=='Confirmada'||!['Preparado','Entregado'].includes(booking.rental_state)||
    !Number.isFinite(start)||!Number.isFinite(end)||end<=start||!reason.trim()||
    (booking.open_ended?end<=Math.max(start,now):!Number.isFinite(previous)||end<=previous)){
    throw new Error('Revise la nueva fecha final y el motivo. La extensión debe superar el fin actual; un alquiler abierto requiere una fecha futura.');
  }
  const cents=Math.round(Number(booking.daily_rate)*100);const days=Math.max(1,Math.ceil((end-start)/86400000));
  const total=cents*days;const oldCents=Math.round(Number(booking.total)*100);
  if(!Number.isSafeInteger(cents)||cents<0||!Number.isSafeInteger(total)||!Number.isSafeInteger(oldCents)||oldCents<0){
    throw new Error('La tarifa o el importe previsto requiere revisión.');
  }
  // Matches the SQL daily_rate * ceil(elapsed seconds / 86400), not calendar-day billing.
  return Object.freeze({command:booking.open_ended?'set_end':'extend',payload:Object.freeze({
    reservationId:booking.id,expectedVersion:booking.version,endsAt:new Date(end).toISOString(),reason:reason.trim(),
  }),currentEnd:booking.ends_at,newEnd:new Date(end).toISOString(),currentForecast:booking.open_ended?null:oldCents/100,
    newForecast:total/100,difference:booking.open_ended?null:(total-oldCents)/100,days});
}
