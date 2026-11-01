import type {SourceWorkbook,OriginalSheet,WorkbookCandidate,WorkbookFormat} from '@/controladores/source-workbooks';
import {caseRpc} from './cases';
import {readRows} from './business';

export interface SourceBook {id:string;file_name:string;file_hash:string;format:WorkbookFormat;parser_version:string;created_at:string;preview?:{sheets:OriginalSheet[]};}
export interface SourceItem {id:string;workbook_id:string;source_ref:string;metadata:WorkbookCandidate;status:'Pendiente'|'Excluido'|'Vinculado'|'Publicado';record_type:string|null;record_id:string|null;reason:string;version:number;}
export interface SourceBundle {book:SourceBook&{preview:{sheets:OriginalSheet[]}};items:SourceItem[];}
export const workbookFormats:Record<WorkbookFormat,string>={diary:'Libro diario',budget:'Presupuesto de taller',fleet:'Calendario de flota',receivables:'Cuentas por cobrar',unknown:'Formato por revisar'};
export function listSourceBooks():Promise<SourceBook[]>{return readRows('source_workbooks','id,file_name,file_hash,format,parser_version,created_at');}
export function stageSourceBook(payload:SourceWorkbook,key:string):Promise<SourceBook>{return caseRpc('stage_source_workbook',{payload,idempotency_key:key});}
export function loadSourceBook(id:string):Promise<SourceBundle>{return caseRpc('source_workbook_bundle',{workbook_id:id});}
export function readSourceOriginal(id:string):Promise<{fileName:string;base64:string}>{return caseRpc('source_workbook_original',{workbook_id:id});}
export function reviewSourceItem(payload:Record<string,unknown>,key:string):Promise<SourceItem>{return caseRpc('review_source_item',{payload,idempotency_key:key});}
export function sourceDuplicateCandidates(recordType:string,proposal:Record<string,unknown>):Promise<{id:string;concept:string;amount:number;date:string}[]>{
  return caseRpc('source_duplicate_candidates',{record_type:recordType,proposal});
}
export async function downloadSourceBook(id:string):Promise<void>{
  const content=await readSourceOriginal(id);
  const bytes=Uint8Array.from(atob(content.base64.replace(/\s/g,'')),c=>c.charCodeAt(0));
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const link=document.createElement('a');link.href=url;link.download=content.fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
