import {cn} from '@/lib/utils';
export function Badge({children,tone='green'}:{children:React.ReactNode;tone?:string}){return <span className={cn('badge',`badge-${tone}`)}><i/>{children}</span>;}
export function statusTone(s:string){return /Por confirmar/.test(s)?'gray':/taller|Pintura|Diagnóstico|Borrador|Presupuesto|Pendiente|Parcial/.test(s)?'amber':/Cancel|Vencido/.test(s)?'red':/curso|Alquilado|proceso|Enviado/.test(s)?'blue':'green';}
