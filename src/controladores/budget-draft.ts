interface DraftAmount {quantity:string;unitPrice:string;unitCost:string;}
interface DraftTotals {prices:number[];costs:(number|null)[];subtotal:number;total:number;cost:number;costComplete:boolean;}

function scaledAmount(value:string):bigint{
  const scaled=Math.round(Number(value)*10000);
  return Number.isSafeInteger(scaled)&&scaled>=0?BigInt(scaled):0n;
}

// Inputs allow four decimals. Multiply scaled integers to avoid binary half-cent errors.
function lineCents(quantity:string,amount:string):bigint{
  return(scaledAmount(quantity)*scaledAmount(amount)+500000n)/1000000n;
}

// The server still validates and freezes every saved version.
export function budgetDraftTotals(lines:DraftAmount[],discount:string):DraftTotals{
  const prices=lines.map(line=>lineCents(line.quantity,line.unitPrice));
  const costs=lines.map(line=>line.unitCost.trim()===''?null:lineCents(line.quantity,line.unitCost));
  const subtotal=prices.reduce((sum,price)=>sum+price,0n);
  return{prices:prices.map(price=>Number(price)/100),costs:costs.map(cost=>cost===null?null:Number(cost)/100),
    subtotal:Number(subtotal)/100,total:Number(subtotal-(scaledAmount(discount)+50n)/100n)/100,
    cost:Number(costs.reduce<bigint>((sum,cost)=>sum+(cost??0n),0n))/100,costComplete:costs.every(cost=>cost!==null)};
}
