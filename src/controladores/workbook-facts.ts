import type {OriginalSheet,WorkbookFormat} from './source-workbooks';
import {adaptSourceSheets} from './source-workbooks';
import {money} from './finanzas';

export interface SourceRecord {reference:string;title:string;detail:string;amount:string;date:string;}
export interface SourceSection {title:string;records:SourceRecord[];}
export interface FleetSourceRow {
  row:number;plate:string;description:string;holder:string;line:string;customer:string;period:string;reservation:string;payment:string;
}
export interface SourceQuoteLine {description:string;kind:string;quantity:string;unitPrice:string;unitCost:null;source:{ref:string};}
const value=(sheet:OriginalSheet,col:string,row:number)=>sheet.rows.find(r=>r.number===row)?.cells.find(c=>c.address===col+row);
const text=(sheet:OriginalSheet,col:string,row:number)=>String(value(sheet,col,row)?.value??'').trim();
const display=(sheet:OriginalSheet,col:string,row:number)=>value(sheet,col,row)?.display??'';

export function humanName(name:string):string{
  return name.trim().replace(/\s+/g,' ').toLocaleLowerCase('es-SV').replace(/(^|[\s.-])\p{L}/gu,c=>c.toLocaleUpperCase('es-SV'));
}

export function fleetSourceRows(sheets:OriginalSheet[]):FleetSourceRow[]{
  return sheets.flatMap(sheet=>{let line='';const rows:FleetSourceRow[]=[];
    for(const row of sheet.rows){
      const n=row.number;const holder=text(sheet,'B',n);if(/^LINEA /i.test(holder)){line=humanName(holder.replace(/^LINEA /i,''));continue;}
      const description=text(sheet,'D',n);if(!description||description==='VEHICULO')continue;
      rows.push({row:n,plate:text(sheet,'C',n),description,holder,line,customer:text(sheet,'H',n),
        period:text(sheet,'F',n),reservation:text(sheet,'E',n),payment:text(sheet,'I',n)});
    }return rows;
  });
}

export function sourceQuoteLines(sheets:OriginalSheet[]):SourceQuoteLine[]{
  const sheet=sheets[0];if(!sheet)return[];const lines:SourceQuoteLine[]=[];
  for(const row of sheet.rows){
    if(row.number>=49)break;const description=text(sheet,'E',row.number);const amount=value(sheet,'F',row.number)?.value;
    if(description&&typeof amount==='number')lines.push({description,kind:/mano de obra|alineado/i.test(description)?'Trabajo':/grua/i.test(description)?'Tercero':'Material',
      quantity:'1',unitPrice:String(amount),unitCost:null,source:{ref:`${sheet.name}!E${row.number}:F${row.number}`}});
  }return lines;
}

// Present source facts without turning ambiguous amounts/dates into posted financial events.
export function workbookSections(format:WorkbookFormat,sheets:OriginalSheet[]):SourceSection[]{
  if(format==='fleet'){
    const sections=new Map<string,SourceRecord[]>();
    for(const row of fleetSourceRows(sheets)){
      const title=row.line||'Vehículos';const records=sections.get(title)??[];
      records.push({reference:`Hoja1!C${row.row}:I${row.row}`,title:`${row.plate||'Placa sin registrar'} · ${humanName(row.description)}`,
        detail:[row.customer&&row.customer!=='NO DISPONIBLE'?humanName(row.customer):'',row.reservation,row.payment].filter(Boolean).join(' · '),
        date:row.period,amount:''});sections.set(title,records);
    }return[...sections].map(([title,records])=>({title,records}));
  }
  if(format==='budget'){
    const sheet=sheets[0];if(!sheet)return[];
    const items=adaptSourceSheets(format,sheets);
    return[
      {title:'Presupuesto al cliente',records:sourceQuoteLines(sheets).map(line=>({reference:line.source.ref,title:line.description,
        detail:line.kind==='Trabajo'?'Mano de obra':line.kind==='Tercero'?'Servicio externo':'Repuesto',date:'',amount:money(Number(line.unitPrice))}))},
      {title:'Costos anotados',records:items.filter(i=>i.category==='Costo por revisar').map(i=>({reference:i.sourceRef,title:i.title,detail:'',date:i.date??'',
        amount:money(Number(value(sheet,'C',i.row)?.value??0))}))},
      {title:'Resumen del archivo',records:[80,81,82,83].map(row=>({reference:`${sheet.name}!B${row}:C${row}`,title:humanName(text(sheet,'B',row)),detail:'',date:'',amount:display(sheet,'C',row)}))},
    ];
  }
  if(format==='receivables'){
    const sections:SourceSection[]=[];
    for(const sheet of sheets){let current:SourceSection|undefined;
      for(const row of sheet.rows){
        const name=text(sheet,'A',row.number);if(name){current={title:humanName(name),records:[]};sections.push(current);}
        if(!current)continue;
        const b=text(sheet,'B',row.number),c=value(sheet,'C',row.number),d=value(sheet,'D',row.number);
        if(!b&&!c&&!d)continue;
        if(!b&&c?.value==='CCF')continue;
        const amount=typeof d?.value==='number'&&!d.date?d:typeof c?.value==='number'&&!c.date?c:undefined;
        const notes=[typeof c?.value==='string'&&c.value.startsWith('#')?'CCF '+c.value.slice(1):'',
          typeof d?.value==='string'?d.value:'',typeof c?.value==='string'&&!c.value.startsWith('#')?c.value:''].filter(Boolean);
        current.records.push({reference:`${sheet.name}!A${row.number}:D${row.number}`,title:b||notes.join(' · ')||'Importe anotado',
          detail:b?notes.join(' · '):'',date:d?.date??'',amount:amount?.display??''});
      }
    }return sections.filter(s=>s.records.length);
  }
  const groups=new Map<string,SourceRecord[]>();
  for(const item of adaptSourceSheets(format,sheets).filter(i=>i.category!=='Control')){
    const date=item.date??'Fecha no indicada';const records=groups.get(date)??[];
    const amount=item.amounts.filter(a=>['D','E','F','G'].some(col=>a.cell===col+item.row)).map(a=>money(a.amount)).join(' · ');
    records.push({reference:item.sourceRef,title:item.title,detail:'',date:'',amount});groups.set(date,records);
  }
  return[...groups].map(([title,records])=>({title,records}));
}
