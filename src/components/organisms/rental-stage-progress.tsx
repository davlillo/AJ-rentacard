'use client';
import {Check,ArrowRight} from 'lucide-react';
import {rentalAccounts,rentalLifecycle,rentalStages,type RentalMoneyEvidence} from '@/controladores/rental-lifecycle';
import {rentalWorkflow} from '@/controladores/rental-workflow';
import {money} from '@/controladores/finanzas';
import type {Reservation,Commitment} from '@/lib/supabase/reservations';
import styles from './rental-stage-progress.module.css';

export function RentalStageProgress({booking,commitments,evidence,shown,onReturnToCurrent,onSelect}:{
  booking:Reservation;commitments:Commitment[];evidence?:RentalMoneyEvidence|null;shown?:number|null;
  onReturnToCurrent?:()=>void;onSelect?:(index:number)=>void;
}){
  const flow=rentalWorkflow(booking,commitments);const progress=rentalLifecycle(booking,flow,evidence);
  const accounts=rentalAccounts(evidence??null);
  const currentStage=progress.currentIndex===null?null:rentalStages[progress.currentIndex];
  // One status line: the current stage, what is still owed and what the flow is doing.
  const status=currentStage
    ?`Etapa actual: ${currentStage}.${accounts?` Pendiente por cobrar: ${money(accounts.pending)}.`:''} ${flow.label}. ${flow.description}`
    :'El folio está cancelado; no se completaron las fases pendientes.';
  return <section className={styles.progress} aria-label="Fases del folio">
    <ol>{progress.stages.map((stage,index)=><li key={stage.label} className={stage.complete?styles.complete:stage.current?styles.current:''}
      aria-current={stage.current?'step':undefined}>
      <button type="button" onClick={()=>onSelect?.(index)} aria-label={`${stage.label}: ${stage.complete?'completado':stage.current?'fase actual':'pendiente'}`}>
        <span className={styles.circle} aria-hidden="true">{stage.complete?<Check size={18}/>:index+1}</span>
        <strong>{stage.label}</strong>
      </button>{index<progress.stages.length-1&&<ArrowRight className={styles.arrow} aria-hidden="true" size={17}/>}
    </li>)}</ol>
    <p className={styles.status} role="status">{status}</p>
    {shown!==undefined&&shown!==null&&progress.currentIndex!==null&&shown!==progress.currentIndex&&
      <p className={styles.caption}>Está consultando la etapa <strong>{rentalStages[shown]}</strong>.
        Consultar no confirma reservas, importes a cobrar, cobros ni devoluciones.
        {onReturnToCurrent&&<button type="button" className="text-link" onClick={onReturnToCurrent}>Volver a la etapa actual</button>}</p>}
  </section>;
}
