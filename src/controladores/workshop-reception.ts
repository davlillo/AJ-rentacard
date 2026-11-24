// The reception of a workshop job records the readings of the vehicle that arrives.
// The readings are facts: they are typed by the operator and stored with the inspection.
// The odometer of the vehicle never decreases and a missing reading never erases the last one.

export interface ReceptionReadings{km:string;fuel:string;accessories:string;review:string;}
export interface ReceptionPayload{orderId:string;km:number;fuel:number;condition:string;accessories:string;
  [key:string]:unknown;}

export const receptionErrors={
  km:'Indique el kilometraje del vehículo con números enteros.',
  kmLower:'El kilometraje no puede ser menor al registrado en el vehículo.',
  fuel:'Indique el combustible entre 0 y 100 por ciento.',
  review:'Describa la revisión general del vehículo.',
} as const;

// A reading that the operator did not take keeps the last known value: the app never
// publishes a number that nobody observed and never blanks a confirmed odometer.
export function receptionPayload(orderId:string,readings:ReceptionReadings,knownKm:number):ReceptionPayload{
  const known=Number.isFinite(knownKm)&&knownKm>=0?Math.trunc(knownKm):0;
  const kmText=readings.km.trim();
  const km=kmText===''?known:Number(kmText);
  if(!Number.isInteger(km)||km<0)throw new Error(receptionErrors.km);
  if(km<known)throw new Error(receptionErrors.kmLower);
  const fuelText=readings.fuel.trim();
  const fuel=fuelText===''?0:Number(fuelText);
  if(!Number.isFinite(fuel)||fuel<0||fuel>100)throw new Error(receptionErrors.fuel);
  const condition=readings.review.trim();
  if(!condition)throw new Error(receptionErrors.review);
  return{orderId,km,fuel,condition,accessories:readings.accessories.trim()};
}
