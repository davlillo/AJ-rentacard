// Client-safe projection of a rental folio. It reads only customer-visible facts:
// internal cost, margin, operator fields and internal reasons are never part of the input contract.
export interface RentalDocumentFacts {
  folioNumber:number|string|null|undefined;
  customerName:string;
  vehicleLabel:string;
  plate?:string|null;
  startsOn?:string|null;
  endsOn?:string|null;
  days?:number|null;
  agreedAmount?:number|null;
  issuedAmount?:number|null;
  appliedAmount?:number|null;
  pendingAmount?:number|null;
  openEnded?:boolean|null;
  statusLabel?:string|null;
  createdAt?:string|null;
}

export interface RentalDocument {
  folioNumber:string;
  customerName:string;
  vehicleLabel:string;
  plate:string;
  startsOn:string;
  endsOn:string;
  days:number|null;
  agreedAmount:number|null;
  issuedAmount:number|null;
  appliedAmount:number|null;
  pendingAmount:number|null;
  openEnded:boolean;
  statusLabel:string;
  createdAt:string;
}

export interface RentalAmountRow {
  key:'agreed'|'issued'|'applied'|'pending';
  label:string;
  value:string;
  // A note explains the exact meaning of the row; it never adds an amount.
  note?:string;
}

const text=(value:unknown):string=>String(value??'').trim().replace(/\s+/g,' ');
const amount=(value:unknown):number|null=>{
  if(value===null||value===undefined||value==='')return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:null;
};

export function rentalFolioLabel(value:number|string|null|undefined):string{
  const raw=text(value);
  const digits=raw.match(/(\d+)/)?.[1];
  return digits?`ALQ-${digits.padStart(5,'0')}`:raw||'ALQ-SIN-FOLIO';
}

// Mirrors the rental day count of the reservations controller: at least one day, rounded up.
export function rentalDayCount(startsOn:string,endsOn:string):number|null{
  if(!startsOn||!endsOn)return null;
  const start=Date.parse(startsOn),end=Date.parse(endsOn);
  if(!Number.isFinite(start)||!Number.isFinite(end))return null;
  return Math.max(1,Math.ceil((end-start)/86400000));
}

const months=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

// Fixed Spanish month names keep the rendered text independent of the device locale and its glyphs.
export function rentalDateLabel(value:string):string{
  const raw=text(value);
  const match=raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!match)return '';
  const month=Number(match[2]),day=Number(match[3]);
  if(month<1||month>12||day<1||day>31)return '';
  return `${String(day).padStart(2,'0')} ${months[month-1]} ${match[1]}`;
}

export function rentalMoney(value:number):string{
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);
}

// The agreed total, the issued documents, the applied money and the pending balance are four different facts.
export function rentalAmountRows(document:RentalDocument):RentalAmountRow[]{
  const rows:RentalAmountRow[]=[
    {key:'agreed',label:'Monto acordado',value:document.openEnded||document.agreedAmount===null?'Sin total acordado':rentalMoney(document.agreedAmount),
      // The agreed total is the agreement, not a receivable: only an issued document creates one.
      note:'Es el monto del acuerdo del contrato; no es una cuenta por cobrar emitida.'},
    {key:'issued',label:'Monto emitido',value:document.issuedAmount===null?'Sin documentos emitidos':rentalMoney(document.issuedAmount)},
    {key:'applied',label:'Monto aplicado',value:document.appliedAmount===null?'Sin pagos aplicados':rentalMoney(document.appliedAmount)},
    {key:'pending',label:'Saldo pendiente',value:document.pendingAmount===null?'No determinado':rentalMoney(document.pendingAmount)},
  ];
  return rows;
}

export function rentalDocument(facts:RentalDocumentFacts):RentalDocument{
  const startsOn=text(facts.startsOn).slice(0,10),endsOn=text(facts.endsOn).slice(0,10);
  const openEnded=Boolean(facts.openEnded);
  const issued=amount(facts.issuedAmount),applied=amount(facts.appliedAmount);
  const pending=amount(facts.pendingAmount)??(issued!==null&&applied!==null?Math.max(0,issued-applied):null);
  return{
    folioNumber:rentalFolioLabel(facts.folioNumber),
    customerName:text(facts.customerName)||'Cliente sin registrar',
    vehicleLabel:text(facts.vehicleLabel)||'Vehículo sin registrar',
    plate:text(facts.plate),
    startsOn,endsOn,
    days:amount(facts.days)??(openEnded?null:rentalDayCount(startsOn,endsOn)),
    // An open rental has no agreed total: the document must not show a zero as if it were agreed.
    agreedAmount:openEnded?null:amount(facts.agreedAmount),
    issuedAmount:issued,appliedAmount:applied,pendingAmount:pending,
    openEnded,
    statusLabel:text(facts.statusLabel)||'Sin estado informado',
    createdAt:text(facts.createdAt)||new Date().toISOString(),
  };
}

export function rentalDocumentFileName(document:RentalDocument):string{
  return `detalle-${document.folioNumber}`;
}
