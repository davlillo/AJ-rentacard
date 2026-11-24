import type {CaseFile,CaseOrder} from '../lib/supabase/cases';
import {operationMoney} from './operation-money';

// The folio has five customer stages and three internal ones. The old "work" stage
// no longer exists: its real costs moved into the money stage that each journey owns
// (collections for a client job, real costs for the internal fleet job).
export type WorkshopSection='summary'|'diagnosis'|'budget'|'approval'|'collections'|'delivery'|'documents';
export interface WorkshopStage {key:WorkshopSection;label:string;complete:boolean;current:boolean;evidence?:string;}

const sectionKeys:WorkshopSection[]=['summary','diagnosis','budget','approval','collections','delivery','documents'];

export function workshopSection(value:string|null):WorkshopSection{
  // Every legacy URL keeps resolving. The names of the removed stage and of the task
  // board point at the stage that now holds their content.
  const aliases:Record<string,WorkshopSection>={
    Resumen:'summary','Recepción':'diagnosis','Diagnóstico':'diagnosis','Ingreso y diagnóstico':'diagnosis',
    Presupuestos:'budget','Costos previstos y presupuesto':'budget','Costos y presupuesto':'budget',Aprobación:'approval','Aprobación del cliente':'approval',
    Costos:'collections',Tareas:'collections',
    'Trabajo y costos reales':'collections','Cargos y abonos':'collections',Cobros:'collections',
    Salida:'delivery',Entrega:'delivery','Fotos y documentos':'documents',
  };
  const key=value??'';
  return sectionKeys.includes(key as WorkshopSection)?key as WorkshopSection:aliases[key]??'summary';
}

// A restricted or internal journey can point at a section its own circles do not
// carry. The internal journey has no budget or approval stage, so both resolve to
// the real costs stage instead of leaving an unhighlighted section.
export function resolvedSection(section:WorkshopSection,job:CaseOrder):WorkshopSection{
  if(job.internal_job&&(section==='budget'||section==='approval'))return 'collections';
  return section;
}

export function workshopPipeline(file:CaseFile,job:CaseOrder,financialAllowed=true){
  const financial=file.financialAccess&&financialAllowed;
  const quotes=(financial?file.quotes??[]:[]).filter(quote=>quote.order_id===job.id).sort((a,b)=>b.revision-a.revision);
  const latest=quotes[0];
  // Approval belongs to the explicitly active scope, not any historic approval.
  const approved=quotes.find(quote=>quote.id===job.active_estimate_id&&quote.status==='Aprobado');
  const received=job.status!=='Presupuesto';
  const delivered=job.status==='Entregado';
  const budgeted=!!latest?.snapshot.lines.length;
  const decided=!!approved&&latest?.id===approved.id;
  const documents=financial?file.documents??[]:[];
  const issued=documents.some(document=>Number(document.scope_amount)>0);
  const outstanding=issued&&documents.some(document=>Number(document.scope_balance)>0);
  const amounts=financial&&!job.internal_job?workshopMoney(file,job.id):null;
  // Settlement is scoped documentary evidence, not proof of work or physical delivery.
  const settled=issued&&documents.every(document=>document.scope_amount!=null&&document.scope_balance!=null&&
    Number.isFinite(Number(document.scope_amount))&&Number(document.scope_amount)>=0&&
    Number(document.scope_balance)===0)&&amounts?.unbilled===0;
  const collectionEvidence=!financial?'Información financiera restringida.':
    outstanding?'Saldo pendiente del importe emitido.':settled?'Importe emitido sin saldo pendiente.':
    amounts?.unbilled?'Trabajo acordado con importe pendiente de emitir.':
    issued?'Cobros del importe emitido por revisar.':'Sin importe a cobrar emitido.';
  // The recommendation is always a stage the journey renders; a delivered job closes it.
  const current:WorkshopSection|null=delivered?null:!received?'diagnosis':job.internal_job?'collections':
    !budgeted?'budget':!decided?'approval':'collections';
  const definitions:[WorkshopSection,string,boolean][]=job.internal_job
    ?[['diagnosis','Ingreso y diagnóstico',received],['collections','Costos reales',delivered],
      ['delivery','Entrega',delivered]]
    :[['diagnosis','Ingreso y diagnóstico',received],['budget','Costos y presupuesto',budgeted],
      ['approval','Aprobación',decided],['collections','Cobros',settled],['delivery','Entrega',delivered]];
  const description=delivered?`Entrega registrada. ${!job.internal_job&&outstanding?'Permanece saldo pendiente del alcance emitido. ':''}La deuda y la disponibilidad de flota se revisan por separado.`:
    !received?'Recepción física pendiente. Un presupuesto no confirma que el vehículo esté en taller.':
    job.internal_job?'Mantenimiento interno: registre los costos del trabajo y revise la entrega. No es una venta al cliente.':
    !financial?'Diagnóstico disponible. El alcance económico requiere autorización financiera.':
    approved&&!decided?`Trabajo acordado vigente: versión ${approved.revision}. La última revisión está ${latest?.status==='Rechazado'?'rechazada':'pendiente de decisión'}; no reemplaza lo ya acordado.`:
    latest?.status==='Rechazado'?'Presupuesto rechazado. Revise el trabajo acordado antes de solicitar una nueva decisión.':
    !budgeted?'Prepare los costos internos y defina por separado el precio del presupuesto al cliente.':
    !decided?'Registre la decisión del cliente sobre la última revisión. Descargar una imagen no registra envío ni aprobación.':
    current==='collections'&&issued&&!settled?`Trabajo acordado y vigente. ${collectionEvidence} Revise los cobros; el trabajo aún no consta finalizado. La entrega requiere su revisión independiente.`:
    'Trabajo acordado y vigente. Registre los costos del trabajo y los cobros; la entrega requiere revisión final.';
  return{stages:definitions.map(([key,label,complete]):WorkshopStage=>({key,label,complete,current:key===current,
    ...(key==='collections'&&!job.internal_job?{evidence:collectionEvidence}:{})})),
    current,description,latest,approved};
}

export function workshopMoney(file:CaseFile,orderId:string){
  // A missing allocation on a shared expense must never expose its full header.
  return operationMoney({...file,expenses:(file.expenses??[]).map(expense=>expense.shared
    ?{...expense,scope_amount:expense.scope_amount??0}:expense)},orderId);
}
