'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useCaseAction} from '@/hooks/use-case-action';
import {useBusiness} from '@/hooks/use-business';
import type {CaseFile} from '@/lib/supabase/cases';
import type {WorkshopCost} from '@/lib/supabase/workshop';
import {money} from '@/controladores/finanzas';
import {allocationSummary,costFinancialAccess} from '@/controladores/workshop-cost-workspace';
import styles from './case-cost-allocations.module.css';

export function CaseCostAllocations({file,onChange,costId,cost}:{file:CaseFile;onChange:()=>Promise<void>;costId?:string;cost?:WorkshopCost}){
  const {can}=useBusiness();
  if(!costFinancialAccess(file.financialAccess,can('expenses.read')))return null;
  const rows=cost?[cost]:(file.costs??[]).filter(row=>!costId||row.id===costId);
  if(costId||cost)return <>{rows.map(row=><CostAllocationForm key={row.id} cost={row} file={file} onChange={onChange}/>)}</>;
  return <section className="mt-5"><h3 className="font-semibold">Desglose de costos y partidas relacionadas</h3>
    <p className="inline-note mt-3">El desglose reparte el costo de este trabajo, no el comprobante compartido entre varios trabajos.</p>
    {rows.map(row=><details key={row.id} className="mt-4"><summary>{row.description} · {money(row.amount)}</summary>
      <CostAllocationForm cost={row} file={file} onChange={onChange}/></details>)}
  </section>;
}
export function CostAllocationForm({cost,file,onChange}:{cost:WorkshopCost;file:CaseFile;onChange:()=>Promise<void>}){
  const {can}=useBusiness();const {busy,error,execute}=useCaseAction(onChange);
  const previous=(file.allocations??[]).filter(a=>a.cost_id===cost.id);
  const initialLines=()=>previous.length?previous.map(a=>({description:a.description,amount:String(a.amount),
    target:a.estimate_id?`${a.estimate_id}:${a.line_index}`:''})):[{description:cost.description,amount:String(cost.amount),target:''}];
  const [lines,setLines]=useState(initialLines);const [dirty,setDirty]=useState(false);
  const [reason,setReason]=useState('');const [validation,setValidation]=useState('');
  const [expectedVersion,setExpectedVersion]=useState(cost.version);
  const formRef=useRef<HTMLFormElement>(null);
  // Never remount by version: a classification refresh must preserve both the
  // unsaved lines and the version against which they were originally edited.
  useEffect(()=>{if(!dirty){setLines(initialLines());setExpectedVersion(cost.version);}},[cost.version,dirty,file.allocations]);
  const summary=allocationSummary(cost.amount,lines);const stale=expectedVersion!==cost.version;
  const access=costFinancialAccess(file.financialAccess,can('expenses.read'));
  if(!access)return null;
  return <form ref={formRef} className={`operation-form ${styles.form}`} onSubmit={event=>{
    event.preventDefault();setValidation('');
    if(!summary.valid){setValidation('Ajuste los conceptos hasta sumar exactamente el costo de este trabajo.');return;}
    if(stale||!can('expenses.write'))return;
    void execute('allocate_cost',{costId:cost.id,expectedVersion,reason:reason.trim(),lines:lines.map(line=>({
      description:line.description,amount:line.amount,estimateId:line.target?line.target.split(':')[0]:null,
      lineIndex:line.target?Number(line.target.split(':')[1]):null}))}).then(saved=>{
        if(saved){setDirty(false);setReason('');}
        else formRef.current?.querySelector<HTMLInputElement>('input')?.focus();
      });
  }}>
    <p className="field-hint">Reparte el mismo costo entre conceptos. El total no aumenta. Guardar reemplaza el desglose anterior.</p>
    <p className="field-hint">{dirty?'Cambios sin guardar.':previous.length?'Desglose guardado.':'Propuesta de desglose sin guardar.'}</p>
    <dl className={styles.totals} aria-label="Conciliación del desglose" aria-live="polite">
      <div><dt>Total del costo</dt><dd>{money(cost.amount)}</dd></div>
      <div><dt>Repartido entre las partidas</dt><dd>{summary.allocated===null?'Complete los importes':money(summary.allocated/100)}</dd></div>
      <div><dt>Sin repartir</dt><dd>{summary.remainder===null?'Por completar':money(summary.remainder/100)}</dd></div>
    </dl>
    <fieldset disabled={busy||!can('expenses.write')} className={styles.fields}>
      {lines.map((line,index)=><div key={index} className={styles.line}>
        <label className="form-field"><span>Concepto desglosado {index+1}</span><input required value={line.description}
          onChange={e=>{setDirty(true);setLines(lines.map((a,i)=>i===index?{...a,description:e.target.value}:a));}}/></label>
        <label className="form-field"><span>Importe desglosado {index+1}</span><input required type="number" min="0.01" step="0.01" value={line.amount}
          onChange={e=>{setDirty(true);setLines(lines.map((a,i)=>i===index?{...a,amount:e.target.value}:a));}}/></label>
        <label className="form-field"><span>Partida relacionada {index+1}</span><select aria-label={`Partida relacionada ${index+1}`} value={line.target}
          onChange={e=>{setDirty(true);setLines(lines.map((a,i)=>i===index?{...a,target:e.target.value}:a));}}><option value="">Sin partida / por clasificar</option>
          {(file.quotes??[]).filter(q=>q.order_id===cost.order_id).flatMap(q=>q.snapshot.lines.map((part,i)=><option
            key={`${q.id}:${i}`} value={`${q.id}:${i}`}>V{q.revision} · {i+1}. {part.description} · {q.status}</option>))}</select></label>
        <Button type="button" variant="ghost" onClick={()=>{setDirty(true);setLines(lines.filter((_,i)=>i!==index));}}>Quitar concepto {index+1}</Button>
      </div>)}
      <Button type="button" variant="outline" disabled={lines.length>=100} onClick={()=>{setDirty(true);setLines([...lines,{description:'',amount:'',target:''}]);}}>Agregar concepto al mismo costo</Button>
      {!lines.length&&<p className="inline-note">Sin conceptos: al guardar se retirará el desglose existente. Indique el motivo de esta decisión.</p>}
      {lines.length>0&&summary.remainder!==null&&summary.remainder!==0&&<p role="status" className="inline-note">
        {summary.remainder<0?`El desglose supera el costo por ${money(-summary.remainder/100)}.`:`Falta repartir ${money(summary.remainder/100)}.`} Debe sumar {money(cost.amount)}.</p>}
      {stale&&<div role="alert" className="inline-note">El costo cambió durante la edición. Se conservó el desglose sin publicarlo. Revise el total actualizado: {money(cost.amount)}.
        <Button type="button" variant="outline" onClick={()=>setExpectedVersion(cost.version)}>Revisé el costo actualizado; conservar mi desglose</Button></div>}
      <label className="form-field"><span>Motivo del desglose</span><input name="reason" required value={reason} onChange={event=>{setDirty(true);setReason(event.target.value);}}/></label>
      <Button type="submit" disabled={stale}>{busy?'Guardando…':lines.length?'Guardar desglose sin duplicar costo':'Retirar desglose con motivo'}</Button>
    </fieldset>
    {(error||validation)&&<p role="alert" className="form-error">{error?`El costo sigue guardado. No se pudo guardar el desglose: ${error} Reintente solo el desglose desde este costo.`:validation}</p>}
  </form>;
}
