import {createSupabaseBrowserClient} from './client';

export type TaskCommand = 'create' | 'assign' | 'transition';
export interface WorkshopAssignee {id: string; label: string;}
export async function workshopAssignees(): Promise<WorkshopAssignee[]> {
  const {data,error} = await createSupabaseBrowserClient().rpc('workshop_assignees');
  if (error) throw new Error('No se pudieron cargar los responsables autorizados.');
  return data as WorkshopAssignee[];
}
export async function executeTaskCommand(command: TaskCommand, payload: Record<string, unknown>, key: string): Promise<void> {
  const {error} = await createSupabaseBrowserClient().rpc('execute_task_command',{command,payload,idempotency_key:key});
  if (error) {
    const messages: Record<string,string> = {
      VERSION_CONFLICT:'La tarea cambió. Actualice la vista antes de intentarlo nuevamente.',
      PERMISSION_DENIED:'No tiene permiso para modificar esta tarea.',
      INVALID_TASK_TRANSITION:'La transición no está permitida desde el estado actual.',
      INVALID_ASSIGNEE:'Seleccione un responsable autorizado.',
      ASSIGNMENT_REASON_REQUIRED:'Indique el motivo de la reasignación.',
      TASK_ALREADY_COMPLETED:'Una tarea finalizada no admite reasignaciones.',
      TASK_HAS_OPEN_TIMER:'Finalice el cronómetro antes de completar o reasignar la tarea.',
      ORDER_NOT_OPEN:'La orden no está abierta.',
      IDEMPOTENCY_CONFLICT:'La clave de esta solicitud ya se usó con otros datos.',
    };
    throw new Error(messages[error.message] ?? 'No se pudo guardar la tarea. Revise los datos y la conexión.');
  }
}
