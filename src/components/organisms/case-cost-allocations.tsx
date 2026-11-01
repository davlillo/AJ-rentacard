'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useCaseAction} from '@/hooks/use-case-action';
import type {CaseFile} from '@/lib/supabase/cases';
import type {WorkshopCost} from '@/lib/supabase/workshop';
import {money} from '@/controladores/finanzas';

export function CaseCostAllocations({file,onChange}:{file:CaseFile;onChange:()=>Promise<void>}){
  return <section className="mt-5"><h3 className="font-semibold">Desglose de comprobantes y vínculo a partidas</h3>
    <p className="inline-note mt-3">Repartir un costo no crea compras, pagos ni cargos. El desglose debe sumar el comprobante completo.</p>
    {(file.costs??[]).map(cost=><details key={cost.id} className="mt-4"><summary>{cost.description} · {money(cost.amount)}</summary>
      <AllocationForm cost={cost} file={file} onChange={onChange}/></details>)}
  </section>;
}
function AllocationForm({cost,file,onChange}:{cost:WorkshopCost;file:CaseFile;onChange:()=>Promise<void>}){
  const {busy,error,execute}=useCaseAction(onChange);
  const previous=(file.allocations??[]).filter(a=>a.cost_id===cost.id);
  const initialLines=()=>previous.length?previous.map(a=>({description:a.description,amount:String(a.amount),
    target:a.estimate_id?`${a.estimate_id}:${a.line_index}`:''})):[{description:cost.description,amount:String(cost.amount),target:''}];
  const [lines,setLines]=useState(initialLines);const [dirty,setDirty]=useState(false);
  const [expectedVersion,setExpectedVersion]=useState(cost.version);
  // Classification/remote refresh must not remount and erase a partly entered
  // split. Keep its original version until the user reviews a concurrent change.
  useEffect(()=>{if(!dirty){setLines(initialLines());setExpectedVersion(cost.version);}},[cost.version,dirty]);
  return <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
    void execute('allocate_cost',{costId:cost.id,expectedVersion,reason:String(f.get('reason')),lines:lines.map(line=>({
      description:line.description,amount:line.amount,estimateId:line.target?line.target.split(':')[0]:null,
      lineIndex:line.target?Number(line.target.split(':')[1]):null}))}).then(saved=>{if(saved)setDirty(false);});
  }}><fieldset disabled={busy} className="contents">
    {lines.map((line,index)=><div key={index} className="form-grid">
      <label className="form-field"><span>Concepto desglosado {index+1}</span><input required value={line.description}
        onChange={e=>{setDirty(true);setLines(lines.map((a,i)=>i===index?{...a,description:e.target.value}:a));}}/></label>
      <label className="form-field"><span>Importe desglosado {index+1}</span><input required type="number" min="0.01" step="0.01" value={line.amount}
        onChange={e=>{setDirty(true);setLines(lines.map((a,i)=>i===index?{...a,amount:e.target.value}:a));}}/></label>
      <label className="form-field"><span>Partida relacionada {index+1}</span><select aria-label={`Partida relacionada ${index+1}`} value={line.target}
        onChange={e=>{setDirty(true);setLines(lines.map((a,i)=>i===index?{...a,target:e.target.value}:a));}}><option value="">Sin partida / por clasificar</option>
        {(file.quotes??[]).filter(q=>q.order_id===cost.order_id).flatMap(q=>q.snapshot.lines.map((part,i)=><option
          key={`${q.id}:${i}`} value={`${q.id}:${i}`}>V{q.revision} · {i+1}. {part.description}</option>))}</select></label>
      <Button type="button" variant="ghost" onClick={()=>{setDirty(true);setLines(lines.filter((_,i)=>i!==index));}}>Quitar concepto {index+1}</Button>
    </div>)}
    <Button type="button" variant="outline" disabled={lines.length>=100} onClick={()=>{setDirty(true);setLines([...lines,{description:'',amount:'',target:''}]);}}>Agregar concepto al mismo comprobante</Button>
    {expectedVersion!==cost.version&&<p role="alert" className="inline-note">El costo cambió durante la edición. Se conservó el desglose sin publicarlo.
      <Button type="button" variant="outline" onClick={()=>setExpectedVersion(cost.version)}>Revisé el costo actualizado; conservar mi desglose</Button></p>}
    <label className="form-field"><span>Motivo del desglose</span><input name="reason" required/></label>
    <Button type="submit" disabled={expectedVersion!==cost.version}>{lines.length?'Guardar desglose sin duplicar costo':'Retirar desglose con motivo'}</Button>
  </fieldset>{error&&<p role="alert" className="form-error">{error}</p>}</form>;
}
