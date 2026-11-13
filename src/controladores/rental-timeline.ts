import type {Vehicle} from '../types';
import type {Commitment,Reservation} from '../lib/supabase/reservations';

const DAY=86400000;
export interface TimelineSegment {left:number;width:number;continuesBefore:boolean;continuesAfter:boolean;}
export interface TimelineEvent extends TimelineSegment {
  id:string;kind:string;customer:string;startsAt:string;endsAt:string;reservationId?:string;orderId?:string;block?:Commitment;
}
export interface TimelineRow {vehicle:Vehicle;events:TimelineEvent[];}
export function timelineDays(from:string,count:number):string[]{
  const start=Date.parse(from+'T12:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!Number.isFinite(start)||new Date(start).toISOString().slice(0,10)!==from||![7,14].includes(count))return[];
  return Array.from({length:count},(_,index)=>new Date(start+index*DAY).toISOString().slice(0,10));
}
export function shiftTimelineDay(day:string,amount:number):string{
  return new Date(Date.parse(day+'T12:00:00Z')+amount*DAY).toISOString().slice(0,10);
}
export function timelineSegment(startsAt:string,endsAt:string,from:string,count:number):TimelineSegment|null{
  if(!timelineDays(from,count).length)return null;
  const first=Date.parse(from+'T00:00:00-06:00');const last=first+count*DAY;
  const start=Date.parse(startsAt);const end=endsAt==='infinity'?Infinity:Date.parse(endsAt);
  if(!Number.isFinite(start)||Number.isNaN(end)||end<=start||end<=first||start>=last)return null;
  return{left:(Math.max(first,start)-first)/(last-first)*100,width:(Math.min(last,end)-Math.max(first,start))/(last-first)*100,
    continuesBefore:start<first,continuesAfter:end>last};
}
export function rentalTimeline(vehicles:Vehicle[],reservations:Reservation[],commitments:Commitment[],from:string,count:number,now=Date.now()):TimelineRow[]{
  return vehicles.map(vehicle=>{
    const events:TimelineEvent[]=[];
    for(const booking of reservations){
      if(booking.vehicle_id!==vehicle.id||booking.status!=='Confirmada'||!['Preparado','Entregado'].includes(booking.rental_state))continue;
      const segment=timelineSegment(booking.starts_at,booking.ends_at,from,count);if(!segment)continue;
      events.push({...segment,id:booking.id,kind:booking.rental_state==='Entregado'?'Alquilado':'Reservado',
        customer:booking.customer_snapshot.name,startsAt:booking.starts_at,endsAt:booking.ends_at,reservationId:booking.id});
    }
    for(const block of commitments){
      if(block.vehicle_id!==vehicle.id||!block.active||block.kind==='Reserva'||(block.ends_at!=='infinity'&&Date.parse(block.ends_at)<=now))continue;
      const segment=timelineSegment(block.starts_at,block.ends_at,from,count);if(!segment)continue;
      events.push({...segment,id:block.id,kind:block.kind,customer:block.reason,startsAt:block.starts_at,endsAt:block.ends_at,
        orderId:block.order_id??undefined,block});
    }
    return{vehicle,events:events.sort((a,b)=>a.startsAt.localeCompare(b.startsAt)||a.id.localeCompare(b.id))};
  });
}
