interface DraftAmount {kind?:string;quantity:string;unitPrice:string;unitCost:string;}
export interface DraftKindTotals {material:number;labor:number;thirdParty:number;indirect:number;}
interface DraftTotals {prices:number[];costs:(number|null)[];subtotal:number;total:number;cost:number;costComplete:boolean;priceComplete:boolean;margin:number|null;
  priceByKind:DraftKindTotals;costByKind:DraftKindTotals;}

type KindKey=keyof DraftKindTotals;

function scaledAmount(value:string):bigint{
  const scaled=Math.round(Number(value)*10000);
  return Number.isSafeInteger(scaled)&&scaled>=0?BigInt(scaled):0n;
}

// Inputs allow four decimals. Multiply scaled integers to avoid binary half-cent errors.
function lineCents(quantity:string,amount:string):bigint{
  return(scaledAmount(quantity)*scaledAmount(amount)+500000n)/1000000n;
}

// The server restricts the line kind to Material, Trabajo, Tercero and Indirecto. An
// unspecified kind is grouped as another cost so no amount disappears from the split.
function kindKey(kind:string|undefined):KindKey{
  return kind==='Material'?'material':kind==='Trabajo'?'labor':kind==='Tercero'?'thirdParty':'indirect';
}

function emptyKindCents():Record<KindKey,bigint>{return{material:0n,labor:0n,thirdParty:0n,indirect:0n};}

function kindAmounts(cents:Record<KindKey,bigint>):DraftKindTotals{
  return{material:Number(cents.material)/100,labor:Number(cents.labor)/100,
    thirdParty:Number(cents.thirdParty)/100,indirect:Number(cents.indirect)/100};
}

// The server still validates and freezes every saved version.
export function budgetDraftTotals(lines:DraftAmount[],discount:string,internal=false):DraftTotals{
  const prices=lines.map(line=>lineCents(line.quantity,line.unitPrice));
  const costs=lines.map(line=>line.unitCost.trim()===''?null:lineCents(line.quantity,line.unitCost));
  const subtotal=prices.reduce((sum,price)=>sum+price,0n);
  const total=subtotal-(scaledAmount(discount)+50n)/100n;
  const cost=costs.reduce<bigint>((sum,amount)=>sum+(amount??0n),0n);
  const costComplete=costs.every(amount=>amount!==null);
  const priceComplete=lines.every(line=>line.unitPrice.trim()!=='');
  // Per-kind subtotals add up to the same lines as the totals above: the client split
  // sums to the subtotal and the internal split sums to the known cost only.
  const priceCents=emptyKindCents();const costCents=emptyKindCents();
  lines.forEach((line,index)=>{const key=kindKey(line.kind);
    priceCents[key]+=prices[index];const amount=costs[index];if(amount!==null)costCents[key]+=amount;});
  return{prices:prices.map(price=>Number(price)/100),costs:costs.map(cost=>cost===null?null:Number(cost)/100),
    subtotal:Number(subtotal)/100,total:Number(total)/100,cost:Number(cost)/100,costComplete,priceComplete,
    margin:!internal&&costComplete&&priceComplete?Number(total-cost)/100:null,
    priceByKind:kindAmounts(priceCents),costByKind:kindAmounts(costCents)};
}

// Additional items (S2) are read back from what the server already stores: an extra line
// is appended to a new full-scope revision, so it sits after the lines copied from its
// parent. The prefix check keeps a rewritten scope from being labelled as an extra.
export interface SnapshotLineForAdditionals {description:string;quantity:number;unitPrice:number;unitCost:number|null;}
export interface BudgetQuoteForAdditionals {id:string;revision:number;parent_id:string|null;status:string;snapshot:{lines:SnapshotLineForAdditionals[]};}
export interface BudgetCostForAdditionals {id:string;description:string;amount:number;disposition:string;estimate_id:string|null;}
export interface AdditionalScopeLine {quoteId:string;revision:number;status:string;description:string;amount:number;}
export interface OutsideApprovedCost {costId:string;description:string;amount:number;}
export interface AdditionalItems {lines:AdditionalScopeLine[];outside:OutsideApprovedCost[];}

function sameMoney(left:number,right:number):boolean{return Math.abs(Math.round(left*100)/100-Math.round(right*100)/100)<0.005;}

export function additionalLineIndexes(lines:SnapshotLineForAdditionals[],parent:SnapshotLineForAdditionals[]):number[]{
  if(!parent.length||lines.length<=parent.length)return[];
  const copied=parent.every((line,index)=>{const candidate=lines[index];
    return !!candidate&&candidate.description===line.description&&Number(candidate.quantity)===Number(line.quantity)
      &&sameMoney(Number(candidate.unitPrice),Number(line.unitPrice));});
  if(!copied)return[];
  return lines.slice(parent.length).map((_,index)=>parent.length+index);
}

// A cost classified "Adicional autorizado" is only inside the budget when an approved
// version of this work already carries it. Anything else is surfaced with its amount
// instead of staying orphaned; no total is invented here.
export function budgetAdditionalItems(quotes:BudgetQuoteForAdditionals[],costs:BudgetCostForAdditionals[]):AdditionalItems{
  const byId=new Map(quotes.map(quote=>[quote.id,quote]));
  const lines:AdditionalScopeLine[]=[];
  for(const quote of quotes){
    const parent=quote.parent_id?byId.get(quote.parent_id):undefined;
    if(!parent)continue;
    for(const index of additionalLineIndexes(quote.snapshot.lines,parent.snapshot.lines)){
      const line=quote.snapshot.lines[index];
      lines.push({quoteId:quote.id,revision:quote.revision,status:quote.status,description:line.description,
        amount:Math.round(Number(line.unitPrice)*Number(line.quantity)*100)/100});
    }
  }
  const approved=quotes.filter(quote=>quote.status==='Aprobado');
  const insideApproved=(cost:BudgetCostForAdditionals)=>approved.some(quote=>quote.snapshot.lines.some(line=>{
    if(line.description.trim().toLowerCase()!==cost.description.trim().toLowerCase())return false;
    const lineAmount=line.unitCost===null?0:Number(line.unitCost)*Number(line.quantity);
    return sameMoney(lineAmount,cost.amount);
  }));
  const outside=costs.filter(cost=>cost.disposition==='Adicional autorizado'&&!insideApproved(cost))
    .map(cost=>({costId:cost.id,description:cost.description,amount:cost.amount}));
  return{lines:lines.sort((left,right)=>left.revision-right.revision),outside};
}
