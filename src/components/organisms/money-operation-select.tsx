'use client';
import {useBusiness} from '@/hooks/use-business';
import {rentalLabel,workLabel} from '@/controladores/linked-money';

export function MoneyOperationSelect({value,onChange,label,emptyLabel,customerId,includeInternal=false}:{
  value:string;onChange:(value:string)=>void;label:string;emptyLabel:string;customerId?:string;includeInternal?:boolean;
}){
  const {data}=useBusiness();
  const jobs=data.orders.filter(job=>(includeInternal||!job.internalJob)&&(customerId===undefined||job.customerId===customerId));
  const rentals=(data.reservationHistory??[]).filter(rental=>customerId===undefined||rental.customerId===customerId);
  return <label className="form-field"><span>{label}</span><select aria-label={label} value={value} onChange={event=>onChange(event.target.value)}>
    <option value="">{emptyLabel}</option>
    <optgroup label="Folios de taller">{jobs.length?jobs.map(job=><option key={job.id} value={'order:'+job.id}>
      Folio {workLabel(data,job.id)}</option>):<option disabled>No hay folios de taller para esta selección</option>}</optgroup>
    <optgroup label="Contratos / reservas de alquiler">{rentals.length?rentals.map(rental=><option key={rental.id} value={'reservation:'+rental.id}>
      {rentalLabel(data,rental.id)}</option>):<option disabled>No hay contratos o reservas de alquiler registrados</option>}</optgroup>
  </select></label>;
}
