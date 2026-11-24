'use client';
import {ArrowRight,Check,FileText,LayoutList} from 'lucide-react';
import type {WorkshopSection,workshopPipeline} from '@/controladores/workshop-pipeline';
import styles from './workshop-stage-progress.module.css';

export interface WorkshopUtility{key:WorkshopSection;label:string;place:'start'|'end';}

// The circles are the only navigation of the folio. The sections that are not stages
// (the summary and the files) are shown in the same row, as utility entries.
export function WorkshopStageProgress({pipeline,onSelect,utilities=[],selected}:{
  pipeline:ReturnType<typeof workshopPipeline>;onSelect:(section:WorkshopSection)=>void;
  utilities?:WorkshopUtility[];selected?:WorkshopSection;
}){
  const start=utilities.filter(utility=>utility.place==='start');
  const end=utilities.filter(utility=>utility.place==='end');
  const total=pipeline.stages.length+utilities.length;
  // The evidence of the stage lives outside the button: a navigation button carries no status.
  const evidence=pipeline.stages.find(stage=>stage.evidence)?.evidence;
  const renderUtility=(utility:WorkshopUtility)=><li key={utility.key} className={styles.utility}>
    <button type="button" aria-pressed={selected===utility.key} onClick={()=>onSelect(utility.key)} aria-label={`${utility.label}: sección`}>
      <span className={styles.circle} aria-hidden="true">{utility.key==='documents'?<FileText size={16}/>:<LayoutList size={16}/>}</span>
      <strong>{utility.label}</strong>
    </button>
  </li>;
  return <section className={styles.progress} aria-label="Fases del trabajo">
    <ol style={{gridTemplateColumns:`repeat(${total}, minmax(0, 1fr))`}}>
      {start.map(renderUtility)}
      {pipeline.stages.map((stage,index)=><li key={stage.key}
        className={stage.complete?styles.complete:stage.current?styles.current:''} aria-current={stage.current?'step':undefined}>
        <button type="button" aria-pressed={selected===stage.key} onClick={()=>onSelect(stage.key)}
          aria-label={`${stage.label}: ${stage.complete?'completado':stage.current?'fase actual':'pendiente'}`}>
          <span className={styles.circle} aria-hidden="true">{stage.complete?<Check size={18}/>:index+1}</span>
          <strong>{stage.label}</strong>
        </button>{index<pipeline.stages.length-1&&<ArrowRight size={16} className={styles.arrow} aria-hidden="true"/>}
      </li>)}
      {end.map(renderUtility)}
    </ol>
    {evidence&&<p className={styles.evidence}>{evidence}</p>}
    <p>{pipeline.description}</p>
    <small>Guía basada en registros existentes. Seleccionar una fase solo abre su sección; no guarda estados.</small>
  </section>;
}
