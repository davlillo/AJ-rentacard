import type {EChartsOption} from 'echarts';
import type {CaseFile,VehicleFile} from '../lib/supabase/cases';
import type {Reservation} from '../lib/supabase/reservations';
import {operationMoney} from './operation-money';
import {rentalAccounts,rentalMoneyEvidence} from './rental-lifecycle';

export const dossierSections=[
  {key:'summary',label:'Resumen'},
  {key:'rentals',label:'Historial de alquileres'},
  {key:'maintenance',label:'Historial de mantenimientos'},
  {key:'financial',label:'Ingresos'},
  {key:'documents',label:'Documentación'},
] as const;
export type DossierSection=typeof dossierSections[number]['key'];
export interface DossierAmounts {
  charged:number|null;paid:number|null;balance:number|null;expenses:number|null;
}
// The money of a selected rental scope: what was agreed and what is still pending. It comes from
// the canonical rental model, never from a second derivation.
export interface DossierRentalAmounts {agreed:number|null;pending:number|null;}
export interface DossierLedgerRow {
  id:string;kind:'Cargo'|'Abono'|'Reversión'|'Egreso';date:string;
  description:string;origin:string;amount:number|null;
}

export function dossierSection(value:string|null):DossierSection{
  const legacy:Record<string,DossierSection>={
    Resumen:'summary',Ingresos:'maintenance',Alquileres:'rentals',Costos:'financial',
    'Cargos y abonos':'financial','Fotos y documentos':'documents','Datos de flota':'summary',
  };
  return dossierSections.find(section=>section.key===value)?.key??legacy[value??'']??'summary';
}

function finite(value:unknown):number|null{
  if(value===null||value===undefined||(typeof value==='string'&&!value.trim())||typeof value==='boolean')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
}

export function dossierMoney(file:CaseFile,allowed:boolean):DossierAmounts|null{
  if(!allowed||!file.financialAccess)return null;
  const amounts=operationMoney(file);
  // Do not let a malformed source value become a reassuring zero.
  const complete=(values:unknown[],total:number)=>values.every(value=>finite(value)!==null)?finite(total):null;
  return{
    charged:complete((file.documents??[]).map(row=>row.scope_amount),amounts.charged),
    paid:complete((file.applications??[]).map(row=>row.scope_amount),amounts.paid),
    balance:complete((file.documents??[]).map(row=>row.scope_balance),amounts.balance),
    expenses:complete((file.expenses??[]).map(row=>row.shared?row.scope_amount:row.scope_amount??row.amount),amounts.cashOut),
  };
}

// The agreed amount and the pending amount of one selected rental scope.
export function dossierRentalScope(file:CaseFile,booking:Reservation,allowed:boolean):DossierRentalAmounts|null{
  if(!allowed||!file.financialAccess)return null;
  const accounts=rentalAccounts(rentalMoneyEvidence(file,booking,null));
  if(!accounts)return null;
  return{agreed:accounts.agreed,pending:accounts.pending};
}

export function dossierLedger(file:CaseFile,allowed:boolean):DossierLedgerRow[]|null{
  if(!allowed||!file.financialAccess)return null;
  const documents=file.documents??[];
  const rows:DossierLedgerRow[]=[
    ...documents.map(row=>({
      id:`document:${row.id}`,kind:'Cargo' as const,date:row.issued_on,description:row.description,
      origin:row.grouped?'Documento agrupado':'Documento emitido',amount:finite(row.scope_amount),
    })),
    ...(file.applications??[]).map(row=>{
      const amount=finite(row.scope_amount);
      return{
        id:`application:${row.id}`,kind:row.kind==='Aplicacion'?'Abono' as const:'Reversión' as const,
        date:row.effective_on,description:row.reason||'Aplicación de pago',
        origin:documents.find(document=>document.id===row.document_id)?.grouped?'Documento agrupado':'Aplicación a cargo',
        amount:amount===null?null:amount*(row.kind==='Aplicacion'?1:-1),
      };
    }),
    ...(file.expenses??[]).map(row=>({
      id:`expense:${row.id}`,kind:'Egreso' as const,date:row.date,description:row.concept,
      origin:row.shared?'Egreso compartido · parte del vehículo':'Egreso vinculado',
      amount:finite(row.shared?row.scope_amount:row.scope_amount??row.amount),
    })),
  ];
  return rows.sort((a,b)=>(b.date??'').localeCompare(a.date??'')||a.id.localeCompare(b.id));
}

export function dossierFiles(file:CaseFile,allowed:boolean):VehicleFile[]{
  return file.files.filter(row=>!row.financial||(allowed&&file.financialAccess));
}

export function sanitizedDossierFile(file:CaseFile,allowed:boolean):CaseFile{
  if(allowed&&file.financialAccess)return file;
  return{...file,financialAccess:false,files:dossierFiles(file,false),
    documents:undefined,applications:undefined,expenses:undefined,quotes:undefined,costs:undefined,
    allocations:undefined,payments:undefined,advances:undefined};
}

export function documentChecklist(files:VehicleFile[]):{purpose:VehicleFile['purpose'];count:number}[]{
  return (['Vehículo','Ingreso','Salida','Soporte'] as const)
    .map(purpose=>({purpose,count:files.filter(row=>row.purpose===purpose).length}));
}

function unique<T extends {id:string}>(rows:T[]):T[]{
  return [...new Map(rows.map(row=>[row.id,row])).values()];
}

export function rentalRows(file:CaseFile):CaseFile['reservations']{
  return unique(file.reservations).sort((a,b)=>b.starts_at.localeCompare(a.starts_at)||a.id.localeCompare(b.id));
}

export function workshopRows(file:CaseFile):(CaseFile['orders'][number]&{reception:string;origin:string})[]{
  return unique(file.orders).sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)||a.id.localeCompare(b.id))
    .map(row=>({...row,reception:row.status==='Presupuesto'?'Sin recepción':'Recibido',
      origin:row.internal_job?'Interno':'Cliente'}));
}

export function dossierDate(value:string|undefined):string{
  if(value==='infinity')return 'Sin fecha final definida';
  if(!value||!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value))return 'Sin fecha registrada';
  const calendar=new Date(value.slice(0,10)+'T12:00:00Z');
  if(!Number.isFinite(calendar.getTime())||calendar.toISOString().slice(0,10)!==value.slice(0,10)){
    return 'Sin fecha registrada';
  }
  const date=new Date(value.length===10?value+'T12:00:00Z':value);
  if(!Number.isFinite(date.getTime()))return 'Sin fecha registrada';
  return date.toLocaleDateString('es-SV',{day:'numeric',month:'short',year:'numeric',timeZone:'America/El_Salvador'});
}

export function dossierChartOption(points:{name:string;value:number}[],currency=false):EChartsOption{
  return{
    textStyle:{fontFamily:'Manrope, sans-serif',color:'#1c304b'},
    grid:{left:12,right:35,top:12,bottom:12,containLabel:true},
    tooltip:{trigger:'axis',renderMode:'richText',confine:true},
    xAxis:{type:'value',minInterval:currency?undefined:1,splitNumber:3,
      axisLabel:{hideOverlap:true},splitLine:{lineStyle:{color:'#edf1f6'}}},
    yAxis:{type:'category',data:points.map(point=>point.name),axisTick:{show:false},
      axisLine:{show:false},axisLabel:{fontSize:11,width:140,overflow:'break'}},
    series:[{name:currency?'Importe (USD)':'Registros',type:'bar',barMaxWidth:22,
      data:points.map(point=>point.value),itemStyle:{color:currency?'#087b70':'#2563eb',borderRadius:[0,4,4,0]},
      label:{show:true,position:'right',color:'#1c304b',fontSize:11}}],
  };
}
