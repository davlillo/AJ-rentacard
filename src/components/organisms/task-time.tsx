'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {loadTaskTime,timeCommand,type TaskTimer,type TimeSpan,type TimeCommand} from '@/lib/supabase/workshop';
import {createSupabaseBrowserClient} from '@/lib/supabase/client';
import type {WorkshopTask} from '@/types';

export function TaskTimeDisclosure({task}:{task:WorkshopTask}){
  const [open,setOpen]=useState(false);
  return <details className="mt-3" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Tiempo de esta tarea</summary>{open&&<TaskTime task={task}/>}</details>;
}

export function TaskTime({task}:{task:WorkshopTask}){
  const [timers,setTimers]=useState<TaskTimer[]>([]);const [spans,setSpans]=useState<TimeSpan[]>([]);
  const [userId,setUserId]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function reload(){const result=await loadTaskTime(task.id);setTimers(result.timers);setSpans(result.spans);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));
    void createSupabaseBrowserClient().auth.getUser().then(({data})=>setUserId(data.user?.id??''));},[task.id]);
  async function submit(command:TimeCommand,payload:Record<string,unknown>){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    try{await timeCommand(command,payload,attempt.current.key);await reload();}
    catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  const live=timers.find(timer=>timer.state!=='Finalizado');
  const total=spans.reduce((seconds,span)=>seconds+Number(span.active_seconds??0),0);
  return <section aria-label={`Tiempos de ${task.description}`} className="operation-form">
    <p>Tiempo activo cerrado: <strong>{(total/3600).toFixed(4)} h</strong> · {total.toFixed(2)} s.
      Un tramo abierto se suma al pausarlo o finalizarlo. Las pausas no suman horas activas.</p>
    <Button variant="outline" disabled={busy} onClick={()=>{void reload().catch(error=>setError(error.message));}}>Actualizar tiempos</Button>
    {!live&&task.status==='En proceso'&&task.assignedTo===userId&&<Button disabled={busy} onClick={()=>{void submit('start',{taskId:task.id});}}>Iniciar cronómetro</Button>}
    {live&&<div><p>Sesión: {live.state} · inicio {new Date(live.started_at).toLocaleString('es-SV')}</p>
      <Button variant="outline" disabled={busy} onClick={()=>{void submit(live.state==='Activo'?'pause':'resume',{timerId:live.id,expectedVersion:live.version});}}>
        {live.state==='Activo'?'Pausar cronómetro':'Reanudar cronómetro'}</Button>
      <Button variant="outline" disabled={busy} onClick={()=>{void submit('finish',{timerId:live.id,expectedVersion:live.version});}}>Finalizar cronómetro</Button>
    </div>}
    {spans.map(span=><div key={span.id} className="inline-note">
      <p>{span.started_at} → {span.ended_at??'Tramo activo abierto'}</p>
      <small>{Number(span.active_seconds??0).toFixed(2)} s · {span.reason} · Autor {span.updated_by} · V{span.version}</small>
      {timers.find(timer=>timer.id===span.timer_id)?.state==='Finalizado'&&<details><summary>Corregir tramo con motivo</summary>
        <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
          void submit('correct',{spanId:span.id,expectedVersion:span.version,startedAt:String(f.get('startedAt')),endedAt:String(f.get('endedAt')),reason:String(f.get('reason'))});
        }}><label className="form-field"><span>Inicio del tramo (ISO con zona horaria)</span><input name="startedAt" defaultValue={span.started_at} required/></label>
          <label className="form-field"><span>Fin del tramo (ISO con zona horaria)</span><input name="endedAt" defaultValue={span.ended_at??''} required/></label>
          <label className="form-field"><span>Motivo de corrección de tiempo</span><input name="reason" required/></label>
          <Button variant="outline" type="submit" disabled={busy}>Guardar corrección de tiempo</Button>
        </form></details>}
    </div>)}
    {error&&<p role="alert" className="form-error">{error}</p>}
  </section>;
}
