'use client';
import {PageHeading} from '@/components/molecules/page-heading';
import {TaskBoard} from '@/components/organisms/task-board';
export function TasksScreen() {
  return <><PageHeading eyebrow="ASIGNACIONES Y SEGUIMIENTO" title="Tareas de taller"
    description="Solo se muestran las tareas autorizadas para su usuario."/><div className="panel p-5"><TaskBoard/></div></>;
}
