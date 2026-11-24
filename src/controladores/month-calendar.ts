const DAY=86400000;
export function monthDays(month:string):string[]{
  const first=Date.parse(month+'-01T12:00:00Z');
  if(!Number.isFinite(first))return[];
  const offset=(new Date(first).getUTCDay()+6)%7;
  return Array.from({length:42},(_,i)=>new Date(first+(i-offset)*DAY).toISOString().slice(0,10));
}
export function shiftMonth(month:string,offset:number):string{
  const date=new Date(month+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+offset);return date.toISOString().slice(0,7);
}
export function intersectsDay(day:string,start:string,end:string):boolean{
  const left=Date.parse(day+'T00:00:00-06:00');const starts=Date.parse(start);
  const ends=end==='infinity'?Infinity:Date.parse(end);
  return Number.isFinite(starts)&&ends>left&&starts<left+DAY;
}
export const calendarDate=(value:string)=>new Date(value).toLocaleDateString('en-CA',{timeZone:'America/El_Salvador'});
