// Pure helpers for the presupuestos workspace: extra items, plain wording and the
// honest re-approval notice. No server calls and no side effects: the version flow,
// the parent check and the freezing of approved revisions stay owned by the server.

export interface ClarityLine {description:string;kind:string;quantity:string;unitPrice:string;unitCost:string;}
export interface ClarityQuoteLine {description:string;kind:string;quantity:number;unitPrice:number;unitCost:number|null;}
export interface ClarityQuote {id:string;revision:number;status:string;snapshot:{lines:ClarityQuoteLine[]};}
export interface ClarityVersion {id:string;parent_id:string|null;status:string;}

export const RE_APPROVAL_NOTICE='El cliente debe aprobar el nuevo total antes de cobrarlo. La versión aprobada anterior sigue vigente hasta que el cliente acepte este total.';
export const ADDITIONAL_REASON_HINT='Explique el cambio. Si agregó un adicional, anote que lo acordó con el cliente; esta nota solo deja constancia y no lo autoriza.';
export const PARENT_VERSION_CONFLICT_NOTICE='Existe una versión más reciente del presupuesto. Actualice el presupuesto antes de crear otra.';

export const clarityLabels={
  internalCost:'Costo interno',
  internalUnitCost:'Costo interno unitario (opcional)',
  internalMargin:'Diferencia entre el precio y el costo (uso interno)',
  missingCost:'Sin costo aún',
  missingPrice:'Sin precio aún',
  approver:'Quién autoriza',
  evidence:'Acuerdo con el cliente (escrito o mensaje)',
} as const;

// The wording the presupuestos workspace must not show any more.
export const removedJargonLabels=['Costo previsto','Costo unitario previsto','Margen previsto · interno','Por completar','Por definir','Persona que decide el alcance','Evidencia de aceptación o rechazo'];

export function clarityEmptyLine(kind='Material'):ClarityLine{
  return{description:'',kind,quantity:'1',unitPrice:'',unitCost:''};
}

export function cloneClarityLines(lines:ClarityLine[]):ClarityLine[]{
  return lines.map(line=>({...line}));
}

export function appendClarityLine(lines:ClarityLine[],kind='Material'):ClarityLine[]{
  return[...cloneClarityLines(lines),clarityEmptyLine(kind)];
}

export function toClarityLines(lines:ClarityQuoteLine[]):ClarityLine[]{
  return lines.map(line=>({description:line.description,kind:line.kind,quantity:String(line.quantity),
    unitPrice:String(line.unitPrice),unitCost:line.unitCost===null?'':String(line.unitCost)}));
}

// Only an approved parent forces a new client agreement; a draft or rejected parent does not.
export function reApprovalNotice(parentStatus:string|null|undefined):string|null{
  return parentStatus==='Aprobado'?RE_APPROVAL_NOTICE:null;
}

export function hasParentVersionConflict(parentId:string|null,latestId:string|null|undefined):boolean{
  return !!latestId&&parentId!==latestId;
}

// A new revision that descends from an approved scope needs a new client agreement,
// even when the version it is copied from is still a draft.
export function needsClientApproval(versions:ClarityVersion[],versionId:string|null|undefined):boolean{
  if(!versionId)return false;
  const byId=new Map(versions.map(version=>[version.id,version]));
  let current:ClarityVersion|undefined=byId.get(versionId);const seen=new Set<string>();
  while(current&&!seen.has(current.id)){
    seen.add(current.id);
    if(current.status==='Aprobado')return true;
    current=current.parent_id?byId.get(current.parent_id):undefined;
  }
  return false;
}

export interface AdditionalItemPlan{
  parentId:string;revision:number;status:'Borrador';section:'pricing';
  lines:ClarityLine[];newLineIndex:number;reApprovalNotice:string|null;
  autoApprove:false;autoIssue:false;
}

// An extra item is a new full-scope revision: the saved scope is copied, one empty
// line is appended and the price of that line is written by hand. Nothing is approved
// or issued here.
export function planAdditionalItem(quote:ClarityQuote,versions:ClarityVersion[]=[]):AdditionalItemPlan{
  const lines=toClarityLines(quote.snapshot.lines);
  const notice=versions.length?(needsClientApproval(versions,quote.id)?RE_APPROVAL_NOTICE:null):reApprovalNotice(quote.status);
  return{parentId:quote.id,revision:quote.revision+1,status:'Borrador',section:'pricing',
    lines:appendClarityLine(lines),newLineIndex:lines.length,
    reApprovalNotice:notice,autoApprove:false,autoIssue:false};
}

export function latestClarityQuote(quotes:ClarityQuote[]):ClarityQuote|null{
  if(!quotes.length)return null;
  return quotes.reduce((latest,current)=>current.revision>latest.revision?current:latest);
}

export function planAdditionalItemForOrder(quotes:ClarityQuote[]):AdditionalItemPlan|null{
  const latest=latestClarityQuote(quotes);
  return latest?planAdditionalItem(latest):null;
}
