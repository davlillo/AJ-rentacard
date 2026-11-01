import * as XLSX from 'xlsx';
import type {CSSProperties} from 'react';
import {checkArchive,IMPORT_LIMITS} from './import-workbook';

export interface WorkbookCell {address:string;text:string;formula?:string;style:CSSProperties;}
export interface WorkbookSheet {
  name:string;columns:number[];heights:Record<number,number>;cells:Record<string,WorkbookCell>;
  rows:number;merges:{startRow:number;startCol:number;endRow:number;endCol:number}[];
}
interface Archive {FullPaths:string[];FileIndex:{content:Uint8Array}[];}
const tags=(xml:string,name:string)=>[...xml.matchAll(new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`,'g'))].map(m=>m[0]);
const attribute=(xml:string,name:string)=>xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]??'';
const cleanText=(value:string)=>value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function color(xml:string,fallback:string):string{
  const rgb=attribute(xml,'rgb');return /^[a-f\d]{6,8}$/i.test(rgb)?'#'+rgb.slice(-6):fallback;
}
function stylesFromXml(xml:string):CSSProperties[]{
  const fonts=tags(xml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)?.[1]??'','font');
  const fills=tags(xml.match(/<fills\b[^>]*>([\s\S]*?)<\/fills>/)?.[1]??'','fill');
  const borders=tags(xml.match(/<borders\b[^>]*>([\s\S]*?)<\/borders>/)?.[1]??'','border');
  return tags(xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1]??'','xf').map(xf=>{
    const font=fonts[Number(attribute(xf,'fontId'))]??'';const fill=fills[Number(attribute(xf,'fillId'))]??'';
    const border=borders[Number(attribute(xf,'borderId'))]??'';const align=tags(xf,'alignment')[0]??'';
    const name=cleanText(attribute(tags(font,'name')[0]??'','val'));
    const horizontal=attribute(align,'horizontal');const vertical=attribute(align,'vertical');
    const style:CSSProperties={fontFamily:/^[\w \-]{1,80}$/.test(name)?`${name}, sans-serif`:'Arial, sans-serif',
      fontSize:Math.max(11,Math.min(36,Number(attribute(tags(font,'sz')[0]??'','val'))*4/3||14)),
      fontWeight:/<b\b/.test(font)?700:400,fontStyle:/<i\b/.test(font)?'italic':'normal',
      color:color(tags(font,'color')[0]??'','#18212f'),
      backgroundColor:attribute(tags(fill,'patternFill')[0]??'','patternType')==='solid'?color(tags(fill,'fgColor')[0]??'','#fff'):'#fff',
      whiteSpace:attribute(align,'wrapText')==='1'?'pre-wrap':'pre',
      verticalAlign:['top','center','bottom'].includes(vertical)?vertical==='center'?'middle':vertical as 'top'|'bottom':'middle',
      textAlign:['left','center','right'].includes(horizontal)?horizontal as 'left'|'center'|'right':undefined};
    for(const side of ['Left','Right','Top','Bottom'] as const){
      const edge=tags(border,side.toLowerCase())[0]??'';const weight=attribute(edge,'style');
      if(weight)style[`border${side}`]=`${/medium|thick|double/.test(weight)?2:1}px ${/dash/.test(weight)?'dashed':'solid'} ${color(tags(edge,'color')[0]??'','#6b7280')}`;
    }
    return style;
  });
}

// Render stored values only. No HTML from cells, formula execution, remote links or macros.
export function renderWorkbook(bytes:Uint8Array):WorkbookSheet[]{
  if(bytes.byteLength<1||bytes.byteLength>IMPORT_LIMITS.bytes)throw new Error('El Excel supera el tamaño permitido.');
  checkArchive(bytes);
  const archive=XLSX.CFB.read(bytes,{type:'array'}) as Archive;
  const xml=(suffix:string)=>{const i=archive.FullPaths.findIndex(p=>p.endsWith('/'+suffix));
    return i<0?'':new TextDecoder().decode(archive.FileIndex[i].content);};
  const styles=stylesFromXml(xml('xl/styles.xml'));
  const book=XLSX.read(bytes,{type:'array',cellStyles:true,cellFormula:true,cellNF:true,sheetRows:2001});
  if(book.SheetNames.length>20)throw new Error('El Excel contiene demasiadas hojas.');
  const relationships=tags(xml('xl/_rels/workbook.xml.rels'),'Relationship');
  const sheetTags=tags(xml('xl/workbook.xml'),'sheet');
  let count=0;
  return book.SheetNames.map((name,index)=>{
    const sheet=book.Sheets[name];const range=XLSX.utils.decode_range(sheet['!fullref']??sheet['!ref']??'A1');
    if(range.e.r>=2000||range.e.c>=50)throw new Error('La hoja supera las 2000 filas o 50 columnas permitidas.');
    const relation=relationships.find(r=>attribute(r,'Id')===attribute(sheetTags[index]??'','r:id'));
    const target=attribute(relation??'','Target').replace(/^\//,'');
    const source=xml(target.startsWith('xl/')?target:`xl/${target||`worksheets/sheet${index+1}.xml`}`);
    const cellStyles=new Map(tags(source,'c').map(c=>[attribute(c,'r'),Number(attribute(c,'s'))]));
    const cells:Record<string,WorkbookCell>={};let lastColumn=0;let lastRow=0;
    for(const address of Object.keys(sheet).filter(key=>!key.startsWith('!'))){
      const cell=sheet[address];const point=XLSX.utils.decode_cell(address);
      if(cell.v===undefined&&!cell.s)continue;
      if(++count>30000)throw new Error('La hoja tiene demasiadas celdas.');
      const text=String(cell.w??cell.v??'');if(text.length>10000)throw new Error('Una celda supera el límite de texto.');
      const style={...styles[cellStyles.get(address)??0]};
      if(cell.t==='n'&&!style.textAlign)style.textAlign='right';
      cells[address]={address,text,formula:cell.f,style};
      if(text){lastColumn=Math.max(lastColumn,point.c);lastRow=Math.max(lastRow,point.r);}
    }
    const merges=(sheet['!merges']??[]).filter(m=>m.s.r<=lastRow&&m.s.c<=lastColumn).map(m=>({
      startRow:m.s.r,startCol:m.s.c,endRow:m.e.r,endCol:m.e.c}));
    if(merges.some(m=>m.startRow<0||m.startCol<0||m.endRow>=2000||m.endCol>=50)||
      merges.reduce((sum,m)=>sum+(m.endRow-m.startRow+1)*(m.endCol-m.startCol+1),0)>100000)
      throw new Error('Las celdas combinadas superan el tamaño permitido.');
    for(const merge of merges){lastColumn=Math.max(lastColumn,merge.endCol);lastRow=Math.max(lastRow,merge.endRow);}
    const heights:Record<number,number>={};
    for(const row of tags(source,'row')){const height=Number(attribute(row,'ht'));
      if(height)heights[Number(attribute(row,'r'))-1]=Math.max(20,Math.min(300,height*4/3));}
    const widths:Record<number,number>={};
    for(const col of tags(source,'col')){
      const start=Number(attribute(col,'min'))-1;const end=Number(attribute(col,'max'))-1;const width=Number(attribute(col,'width'));
      if(start>=0&&end<50&&width>0)for(let c=start;c<=end;c++)widths[c]=Math.max(40,Math.min(600,Math.round(width*7)));
    }
    return{name,cells,columns:Array.from({length:Math.max(lastColumn,range.e.c)+1},(_,c)=>
      widths[c]??76),heights,rows:Math.max(lastRow,range.e.r)+1,merges};
  });
}

export const columnName=(index:number):string=>XLSX.utils.encode_col(index);
