// Decides whether the folio should move to the stage that now applies. It is a pure
// function on purpose: the visible section follows the derived stage only after a
// successful action, never while a form is being typed and never against a manual pick.
export type StageAdvanceReason='advanced'|'unchanged'|'manual-selection'|'form-dirty'|'not-confirmed'|'no-stage';

export interface StageAdvanceFacts<T> {
  // The derived stage observed before the reload that followed the action.
  previous:T|null;
  // The derived stage after that reload.
  current:T|null;
  // True only when the reload followed a successful command.
  confirmed:boolean;
  // True while the operator has unsaved input in a form of the folio.
  dirty:boolean;
  // True when the operator chose a stage by hand and no action happened since.
  manual:boolean;
}

export interface StageAdvanceDecision<T> {advance:boolean;stage:T|null;reason:StageAdvanceReason;}

export function stageAdvance<T>(facts:StageAdvanceFacts<T>):StageAdvanceDecision<T>{
  const {previous,current,confirmed,dirty,manual}=facts;
  if(current===null||current===undefined)return{advance:false,stage:null,reason:'no-stage'};
  if(!confirmed)return{advance:false,stage:current,reason:'not-confirmed'};
  if(dirty)return{advance:false,stage:current,reason:'form-dirty'};
  if(manual)return{advance:false,stage:current,reason:'manual-selection'};
  if(previous!==null&&previous!==undefined&&Object.is(previous,current))
    return{advance:false,stage:current,reason:'unchanged'};
  return{advance:true,stage:current,reason:'advanced'};
}

// True while the operator is typing in a form of the folio: the advance must wait.
export function typingInFolio(root:HTMLElement|null|undefined):boolean{
  if(!root||typeof document==='undefined')return false;
  const active=document.activeElement as HTMLElement|null;
  if(!active||!root.contains(active))return false;
  if(active.isContentEditable)return true;
  return active.tagName==='INPUT'||active.tagName==='TEXTAREA'||active.tagName==='SELECT';
}
