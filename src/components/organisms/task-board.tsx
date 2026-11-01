'use client';
import {useEffect, useRef, useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {executeTaskCommand, workshopAssignees, type TaskCommand, type WorkshopAssignee} from '@/lib/supabase/tasks';
import {TaskTimeDisclosure} from '@/components/organisms/task-time';
import {AdaptiveTable} from './adaptive-table';
import {Pagination,usePagination} from './pagination';
import {folio} from '@/controladores/folios';

export function TaskBoard({orderId}: {orderId?: string}) {
  const {data, can, refresh, toast} = useBusiness();
  const [staff, setStaff] = useState<WorkshopAssignee[]>([]);
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const attempt = useRef<{body: string; key: string} | null>(null);
  const manager = can('orders.write');
  const tasks = (data.tasks ?? []).filter(task => !orderId || task.orderId === orderId);
  const page=usePagination(tasks,orderId??'');
  useEffect(() => {
    let active = true;
    if (manager) void workshopAssignees().then(staff => {if (active) setStaff(staff);})
      .catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [manager]);

  async function submit(command: TaskCommand, payload: Record<string,unknown>) {
    if (sending.current) return;
    const body = JSON.stringify({command,payload});
    if (attempt.current?.body !== body) attempt.current = {body,key:crypto.randomUUID()};
    sending.current = true; setBusy(true); setError('');
    try {
      await executeTaskCommand(command,payload,attempt.current.key);
      await refresh().catch(() => setError('El cambio se guardó, pero falta actualizar la vista.'));
      if (command === 'create') {setDescription(''); setAssignedTo('');}
      toast('Tarea guardada. Las demás tareas y la orden conservan su estado.');
    } catch (error) {setError((error as Error).message);}
    finally {sending.current = false; setBusy(false);}
  }
  return <section aria-label={orderId ? `Tareas de ${orderId}` : 'Tareas asignadas'}>
    {manager && orderId && <form className="operation-form mb-6" onSubmit={event => {
      event.preventDefault(); void submit('create',{orderId,description,assignedTo});
    }}>
      <label className="form-field"><span>Nueva tarea</span><input aria-label="Nueva tarea" required maxLength={2000}
        disabled={busy} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <label className="form-field"><span>Responsable de la nueva tarea</span>
        <select aria-label="Responsable de la nueva tarea" required disabled={busy} value={assignedTo}
          onChange={event => setAssignedTo(event.target.value)}><option value="">Seleccionar responsable</option>
          {staff.map(person => <option key={person.id} value={person.id}>{person.label}</option>)}
        </select></label><Button type="submit" disabled={busy}>Crear tarea</Button>
    </form>}
    <div className="table-scroll"><AdaptiveTable><thead><tr><th>Tarea / orden</th><th>Responsable</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>{page.items.map(task => <tr key={task.id}><td><strong>{task.description}</strong><small>{folio('OT',task.orderId)}</small></td>
        <td>{task.assigneeLabel}</td><td><Badge tone={task.status === 'Finalizada' ? 'green' : 'blue'}>{task.status}</Badge></td>
        <td>{task.status !== 'Finalizada' && <Button variant="outline" disabled={busy} onClick={() => {void submit('transition',{
          taskId:task.id,expectedVersion:task.version,status:task.status === 'Pendiente' ? 'En proceso' : 'Finalizada',
        });}}>{task.status === 'Pendiente' ? 'Iniciar tarea' : 'Finalizar tarea'}</Button>}
        {manager && task.status !== 'Finalizada' && <details className="mt-3"><summary>Reasignar responsable</summary>
          <form className="operation-form" onSubmit={event => {
            event.preventDefault(); const fields = new FormData(event.currentTarget);
            void submit('assign',{taskId:task.id,expectedVersion:task.version,
              assignedTo:String(fields.get('assignedTo')),reason:String(fields.get('reason'))});
          }}><select aria-label={`Responsable de ${task.description}`} name="assignedTo" defaultValue={task.assignedTo} disabled={busy}>
            {staff.map(person => <option key={person.id} value={person.id}>{person.label}</option>)}</select>
            <input aria-label={`Motivo de reasignación de ${task.description}`} name="reason" required placeholder="Motivo obligatorio" disabled={busy}/>
            <Button variant="outline" type="submit" disabled={busy}>Guardar reasignación</Button>
          </form></details>}
          <TaskTimeDisclosure task={task}/></td>
      </tr>)}</tbody></AdaptiveTable></div><Pagination {...page}/>
    {!tasks.length && <p className="p-4">No hay tareas visibles para este usuario.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
