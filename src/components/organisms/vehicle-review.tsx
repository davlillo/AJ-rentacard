'use client';
import {useId} from 'react';

export function VehicleReviewField(){
  const hint=useId();const label=useId();
  return <label className="form-field"><span id={label}>Revisión general del vehículo (360°)</span>
    <textarea name="review" required maxLength={4000} rows={6} aria-labelledby={label} aria-describedby={hint}
      placeholder="Describa kilometraje y combustible observados, rayones o daños, tarjeta de circulación, herramientas, llanta de repuesto, vidrios, luces y cualquier otra observación."/>
    <small id={hint} className="field-hint">Registre todo en esta caja. No se exige un formato ni se actualiza automáticamente el odómetro.</small>
  </label>;
}

export function VehicleReviewNotes({condition,accessories,evidence,km,fuel}:{
  condition:string;accessories?:string;evidence?:string;km:number|null;fuel:number|null;
}){
  const notes=[...new Set([condition,accessories,evidence].filter(Boolean))];
  return <div className="vehicle-review-notes">
    {(km!==null||fuel!==null)&&<p className="field-hint">{[km!==null?`${km.toLocaleString()} km`:null,fuel!==null?`${fuel}% de combustible`:null].filter(Boolean).join(' · ')}</p>}
    {notes.map((note,index)=><p key={index}>{note}</p>)}
  </div>;
}
