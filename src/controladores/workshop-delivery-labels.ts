// The delivery review speaks to the operator: no internal identifiers, no raw timestamps.
// Every label comes from the records the folio already shows.

import {money} from './finanzas';
import {rentalDateTime} from './rental-workflow';

export interface DeliveryCost{id:string;description:string;amount:number;disposition:string;}

// The pending revision is named by its folio, the same way the budget list names it.
export function deliveryPendingVersion(pendingEstimate:string|null|undefined,labels:Record<string,string>):string{
  if(!pendingEstimate)return 'Ninguna';
  return labels[pendingEstimate]??'Versión sin folio visible';
}

// A cost without disposition is identified by what it is, never by its internal id.
export function deliveryPendingCost(cost:DeliveryCost):string{
  return `${cost.description} · ${money(cost.amount)}`;
}

// The act keeps its facts and shows them in the local calendar of the business.
export function deliveryActaMoment(createdAt:string|undefined|null):string{
  if(!createdAt)return 'Fecha por revisar';
  return rentalDateTime(createdAt);
}
