'use client';
import {useEffect, useRef, useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/atoms/badge';
import {executeTaskCommand, normalizeResponsibleName, responsibleNameMaxLength, responsibleNameMigrationMessage, workshopAssignees,
  type TaskCommand, type WorkshopAssignee} from '@/lib/supabase/tasks';
import type {WorkshopTask} from '@/types';
import {TaskTimeDisclosure} from '@/components/organisms/task-time';
import {AdaptiveTable} from './adaptive-table';
import {Pagination,usePagination} from './pagination';
import {folio} from '@/controladores/folios';
import styles from './task-board.module.css';

export function TaskBoard({orderId}: {orderId?: string}) {
  const {data, can, refresh, toast} = useBusiness();
  const [staff, setStaff] = useState<WorkshopAssignee[]>([]);
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [responsibleName, setResponsibleName] = useState('');
  const [editing, setEditing] = useState<WorkshopTask|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const attempt = useRef<{body: string; key: string} | null>(null);
  const manager = can('orders.write');
  const nameAvailable = data.taskResponsibleNameAvailable !== false;
  const tasks = (data.tasks ?? []).filter(task => !orderId || task.orderId === orderId);
  const page=usePagination(tasks,orderId??'');
  useEffect(() => {
    let active = true;
    if (manager) void workshopAssignees().then(staff => {if (active) setStaff(staff);})
      .catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [manager]);
  useEffect(() => {if (!manager) {setStaff([]); setEditing(null); setResponsibleName('');}}, [manager]);
  useEffect(() => {if (error) errorRef.current?.focus();}, [error]);

  async function submit(command: TaskCommand, payload: Record<string,unknown>) {
    if (sending.current) return false;
    const body = JSON.stringify({command,payload});
    if (attempt.current?.body !== body) attempt.current = {body,key:crypto.randomUUID()};
    sending.current = true; setBusy(true); setError('');
    try {
      await executeTaskCommand(command,payload,attempt.current.key);
      await refresh().catch(() => setError('El cambio se guardó, pero falta actualizar la vista.'));
      if (command === 'create') {setDescription(''); setAssignedTo(''); setResponsibleName('');}
      if (command === 'assign') setEditing(null);
      toast('Tarea guardada. Las demás tareas y la orden conservan su estado.');
      return true;
    } catch (error) {setError((error as Error).message); return false;}
    finally {sending.current = false; setBusy(false);}
  }
  return <section className={styles.board} aria-label={orderId ? `Tareas de ${orderId}` : 'Tareas asignadas'}>
    <header className={styles.heading}><h3>Tareas y responsables</h3>
      <p>El nombre indica quién hace el trabajo. La cuenta de seguimiento conserva los permisos y cronómetros.</p></header>
    {manager && !nameAvailable && <p className={styles.notice} role="status">
      Para guardar nombres de responsables se requiere actualizar la base de datos.
      Puede seguir creando tareas con una cuenta de seguimiento.</p>}
    {manager && orderId && <form className={`operation-form mb-6 ${styles.create}`} onSubmit={event => {
      event.preventDefault();
      if (!nameAvailable && normalizeResponsibleName(responsibleName)) {
        setError(responsibleNameMigrationMessage); return;
      }
      void submit('create',{orderId,description,assignedTo,
        ...(nameAvailable ? {responsibleName:normalizeResponsibleName(responsibleName)} : {})});
    }}>
      <label className="form-field"><span>Nueva tarea</span><input aria-label="Nueva tarea" required maxLength={2000}
        disabled={busy} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <label className="form-field"><span>Responsable del trabajo</span>
        <input aria-label="Responsable del trabajo" maxLength={responsibleNameMaxLength}
          placeholder="Escriba el nombre, aunque no tenga cuenta" disabled={busy || !nameAvailable}
          value={responsibleName} onChange={event => setResponsibleName(event.target.value)}/>
        <small>Opcional. No crea una cuenta ni concede acceso.</small></label>
      <label className={`form-field ${styles.account}`}><span>Cuenta de seguimiento</span>
        <select aria-label="Cuenta de seguimiento" required disabled={busy} value={assignedTo}
          onChange={event => setAssignedTo(event.target.value)}><option value="">Seleccionar cuenta autorizada</option>
          {staff.map(person => <option key={person.id} value={person.id}>{person.label}</option>)}
        </select></label><Button type="submit" disabled={busy}>Crear tarea</Button>
    </form>}
    <div className="table-scroll"><AdaptiveTable><thead><tr><th>Tarea / orden</th><th>Responsable del trabajo</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>{page.items.map(task => <tr key={task.id}><td><strong>{task.description}</strong><small>{folio('OT',task.orderId)}</small></td>
        <td><strong>{task.responsibleName || 'Sin nombre registrado'}</strong>
          <small className={styles.account}>Cuenta de seguimiento: {task.assigneeLabel}</small></td>
        <td><Badge tone={task.status === 'Finalizada' ? 'green' : 'blue'}>{task.status}</Badge></td>
        <td>{task.status !== 'Finalizada' && <Button variant="outline" disabled={busy} onClick={() => {void submit('transition',{
          taskId:task.id,expectedVersion:task.version,status:task.status === 'Pendiente' ? 'En proceso' : 'Finalizada',
        });}}>{task.status === 'Pendiente' ? 'Iniciar tarea' : 'Finalizar tarea'}</Button>}
        {manager && task.status !== 'Finalizada' && <div className={styles.editor}>
          {editing?.id !== task.id ? <Button variant="outline" disabled={busy} onClick={() => {
            setEditing({...task}); setError('');
          }}>Editar responsable y cuenta</Button> :
          <form className="operation-form" aria-label={`Responsable de ${task.description}`} onSubmit={event => {
            event.preventDefault(); const fields = new FormData(event.currentTarget);
            const nameField = event.currentTarget.elements.namedItem('responsibleName') as HTMLInputElement;
            if (!nameAvailable && nameField.value !== (editing.responsibleName ?? '')) {
              setError(responsibleNameMigrationMessage); return;
            }
            void submit('assign',{taskId:editing.id,expectedVersion:editing.version,
              assignedTo:String(fields.get('assignedTo')),reason:String(fields.get('reason')),
              ...(nameAvailable ? {responsibleName:normalizeResponsibleName(String(fields.get('responsibleName')))} : {})});
          }}>
            <label className="form-field"><span>Responsable del trabajo</span>
              <input aria-label={`Responsable del trabajo de ${task.description}`} name="responsibleName"
                defaultValue={editing.responsibleName ?? ''} maxLength={responsibleNameMaxLength}
                disabled={busy || !nameAvailable} autoFocus/></label>
            <label className="form-field"><span>Cuenta de seguimiento</span>
              <select aria-label={`Cuenta de seguimiento de ${task.description}`} name="assignedTo"
                defaultValue={editing.assignedTo} required disabled={busy}>
              {!staff.some(person => person.id === editing.assignedTo) &&
                <option value={editing.assignedTo}>{editing.assigneeLabel}</option>}
            {staff.map(person => <option key={person.id} value={person.id}>{person.label}</option>)}</select>
            </label>
            <label className="form-field"><span>Motivo del cambio</span>
              <input aria-label={`Motivo del cambio de ${task.description}`} name="reason" required
                placeholder="Indique por qué cambia el nombre o la cuenta" disabled={busy}/></label>
            <Button variant="outline" type="submit" disabled={busy}>Guardar responsable y cuenta</Button>
            <Button variant="ghost" type="button" disabled={busy} onClick={() => setEditing(null)}>Cancelar</Button>
          </form>}</div>}
          <TaskTimeDisclosure task={task}/></td>
      </tr>)}</tbody></AdaptiveTable></div><Pagination {...page}/>
    {!tasks.length && <p className="p-4">No hay tareas visibles para este usuario.</p>}
    {error && <p ref={errorRef} tabIndex={-1} className="form-error" role="alert">{error}</p>}
  </section>;
}
