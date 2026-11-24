// Plain-language money wording for the workshop surfaces. Pure module: it only names
// facts that already exist and never issues, approves or settles anything. Every amount
// comes from the canonical money helpers, so an amount that is not known stays unknown
// instead of turning into a zero.

export const NOT_AVAILABLE='Sin dato';

export const workshopMoneyLabels={
  receivableHeading:'Lo que el cliente debe',
  receivableNote:'Lo acordado, lo que ya se emitió, lo cobrado y lo que falta cobrar de este trabajo.',
  costsHeading:'Costos del trabajo',
  costsNote:'Lo que el taller gastó en este trabajo. No es lo que el cliente debe, así que no forma parte del saldo de cobro.',
  paidToSupplier:'Pagado al proveedor',
  paidToSupplierNote:'Dinero que el taller ya pagó por los costos de este trabajo',
  pendingWithSupplier:'Pendiente con el proveedor',
  pendingWithSupplierNote:'Dinero que el taller todavía debe a sus proveedores',
  agreedHeading:'Importe acordado con el cliente',
  agreedAvailable:'Trabajo acordado con el cliente, incluidos los adicionales autorizados.',
  agreedMissing:'No hay un presupuesto aprobado para este trabajo, así que el importe acordado no se puede mostrar.',
  issued:'Importe facturado al cliente',
  issuedNote:'Documentos de cobro emitidos de este trabajo',
  collected:'Cobro aplicado a este trabajo',
  collectedNote:'Cobros aplicados menos reversiones',
  pending:'Pendiente de cobro',
  pendingNote:'Saldo de este trabajo, no de todo el cliente',
  advance:'Anticipo disponible',
  advanceNote:'Dinero ya recibido y disponible',
  notInvoiced:'Acordado y aún sin documento de cobro emitido',
  notInvoicedNote:'Lo acordado sin documento emitido todavía no es una deuda por cobrar.',
  notInvoicedMissing:'Sin un presupuesto aprobado no hay importe acordado que emitir.',
  additionalNote:'Un adicional aprobado sube el importe acordado con el cliente y, por eso, aumenta lo pendiente de cobro hasta que el cliente paga.',
  internalNote:'Mantenimiento interno: no se genera cuenta por cobrar a AJ. No hay importe acordado, facturado ni pendiente para el cliente.',
  document:'Documento de cobro',
  prepareAction:'Preparar importe a cobrar',
  issueAction:'Emitir importe a cobrar',
} as const;

// Wording the workshop surfaces must not show any more. The legacy section alias
// "Cargos y abonos" is not one of them: it stays as a URL alias so old links resolve.
export const removedWorkshopJargon=['Cargos emitidos','Cargos y cobros','Emitir cargo','Total acordado','Acordado aún sin emitir'];

export interface WorkshopMoneySummary{
  known:boolean;agreed:number|null;charged:number;paid:number;balance:number;advances:number;unbilled:number;
}
export interface WorkshopFact{label:string;note:string;value:number;}
export interface WorkshopOptionalFact{label:string;note:string;value:number|null;available:boolean;}
export interface WorkshopReceivableOverview{
  agreed:WorkshopOptionalFact;issued:WorkshopFact;collected:WorkshopFact;pending:WorkshopFact;advance:WorkshopFact;
  notInvoiced:WorkshopOptionalFact;additionalNote:string;
}

// The approved scope is the approved total of the estimate the order points at. When the
// order has no approved active estimate the amount is unknown, not zero.
export function workshopReceivableOverview(summary:WorkshopMoneySummary):WorkshopReceivableOverview{
  const approved=summary.agreed!==null&&summary.agreed!==undefined&&Number.isFinite(Number(summary.agreed));
  const agreed:WorkshopOptionalFact={label:workshopMoneyLabels.agreedHeading,
    note:approved?workshopMoneyLabels.agreedAvailable:workshopMoneyLabels.agreedMissing,
    value:approved?Number(summary.agreed):null,available:approved};
  return{
    agreed,
    issued:{label:workshopMoneyLabels.issued,note:workshopMoneyLabels.issuedNote,value:summary.charged},
    collected:{label:workshopMoneyLabels.collected,note:workshopMoneyLabels.collectedNote,value:summary.paid},
    pending:{label:workshopMoneyLabels.pending,note:workshopMoneyLabels.pendingNote,value:summary.balance},
    advance:{label:workshopMoneyLabels.advance,note:workshopMoneyLabels.advanceNote,value:summary.advances},
    notInvoiced:{label:workshopMoneyLabels.notInvoiced,
      note:approved?workshopMoneyLabels.notInvoicedNote:workshopMoneyLabels.notInvoicedMissing,
      value:approved?summary.unbilled:null,available:approved},
    additionalNote:workshopMoneyLabels.additionalNote,
  };
}

// An amount that is not known is written as such. It is never rendered as $0.00.
export function workshopAmountText(amount:WorkshopOptionalFact,format:(value:number)=>string):string{
  return amount.available&&amount.value!==null?format(amount.value):NOT_AVAILABLE;
}

// The amount agreed with the client is the approved scope. A newer revision in draft
// never becomes the agreed amount: it is not agreed until the customer decides it.
export function approvedScopeTotal(file:{
  quotes?:{id:string;order_id:string;status:string;snapshot:{total:number}}[];
  orders?:{id:string;active_estimate_id?:string|null}[];
},orderId?:string):number|null{
  const quotes=file.quotes??[];
  const order=orderId?file.orders?.find(row=>row.id===orderId):file.orders?.[0];
  if(!order)return null;
  const approved=quotes.find(quote=>quote.id===order.active_estimate_id&&quote.status==='Aprobado')
    ??quotes.find(quote=>quote.order_id===order.id&&quote.status==='Aprobado');
  if(!approved)return null;
  const total=Number(approved.snapshot.total);
  return Number.isFinite(total)?total:null;
}

// The state of the collection, in the words of the operator. The internal state names
// ("Sin cargo") never reach the screen of the workshop.
export function workshopCollectionState(state:string):string{
  if(state==='Pendiente')return 'Pendiente de cobro';
  if(state==='Por emitir')return 'Falta emitir el importe a cobrar';
  if(state==='Sin saldo')return 'Cobrado';
  if(state==='Por aprobar')return 'Pendiente de aprobación del trabajo acordado';
  if(state==='Rechazado')return 'Trabajo acordado rechazado';
  if(state==='Pago parcial')return 'Pago parcial';
  if(state==='Por cobrar')return 'Por cobrar';
  return 'Sin importe emitido';
}
