import {createSupabaseBrowserClient} from './client';

export type TaskCommand = 'create' | 'assign' | 'transition';
export interface WorkshopAssignee {id: string; label: string;}
export const responsibleNameMaxLength = 120;
export const responsibleNameMigrationMessage = 'El nombre del responsable requiere actualizar la base de datos. No se confirmó su guardado.';

export function normalizeResponsibleName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('El nombre del responsable debe ser texto.');
  const name = value.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '');
  if (Array.from(name).length > responsibleNameMaxLength) {
    throw new Error(`El nombre del responsable admite hasta ${responsibleNameMaxLength} caracteres.`);
  }
  return name || null;
}

export async function workshopAssignees(): Promise<WorkshopAssignee[]> {
  const {data,error} = await createSupabaseBrowserClient().rpc('workshop_assignees');
  if (error) throw new Error('No se pudieron cargar los responsables autorizados.');
  return data as WorkshopAssignee[];
}
export async function executeTaskCommand(command: TaskCommand, payload: Record<string, unknown>, key: string): Promise<void> {
  const hasName = Object.prototype.hasOwnProperty.call(payload, 'responsibleName');
  if (hasName) {
    if (command === 'transition') throw new Error('El cambio de estado no permite editar el responsable del trabajo.');
    normalizeResponsibleName(payload.responsibleName);
  }
  // Keep the original payload intact for actor-scoped idempotency comparison.
  const {data,error} = await createSupabaseBrowserClient().rpc('execute_task_command',{command,payload,idempotency_key:key});
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
      INVALID_RESPONSIBLE_NAME:'Indique un nombre de hasta 120 caracteres o deje el campo vacío.',
      UNSUPPORTED_TASK_METADATA:'El cambio de estado no permite editar el responsable del trabajo.',
      RESPONSIBLE_NAME_MIGRATION_REQUIRED:responsibleNameMigrationMessage,
    };
    throw new Error(messages[error.message] ?? 'No se pudo guardar la tarea. Revise los datos y la conexión.');
  }
  if (hasName && data?.responsibleNameSupported !== true) throw new Error(responsibleNameMigrationMessage);
}
