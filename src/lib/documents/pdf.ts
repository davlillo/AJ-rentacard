import {PDFDocument,rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type {QuoteVersion} from '@/lib/supabase/estimates';
import {folio} from '@/controladores/folios';

export interface DocumentContent {title:string;reference:string;createdAt:string;sections:{heading:string;lines:string[]}[];}
const dollars=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);

export function quoteDocumentContent(quote:QuoteVersion):DocumentContent{
  // Whitelist client-visible values: never serialize the internal calculation or cost fields.
  return{title:'Presupuesto de servicio',reference:`${folio('PRE',quote.folio_number)} · Versión ${quote.revision}`,
    createdAt:quote.created_at,sections:[
      {heading:'Cliente y vehículo',lines:[quote.customer_snapshot.name,
        `Documento: ${quote.customer_snapshot.document||'Sin registrar'}`,
        `Vehículo: ${quote.vehicle_snapshot.brand} ${quote.vehicle_snapshot.model} ${quote.vehicle_snapshot.year} - ${quote.vehicle_snapshot.plate||'Placa sin registrar'}`,
        `Versión ${quote.revision} - Estado: ${quote.status}`]},
      {heading:'Alcance de esta versión',lines:quote.snapshot.lines.map(line=>
        `${line.quantity} x ${line.description}${quote.snapshot.method==='commercial'?` - ${dollars(line.price)}`:''}`)},
      {heading:'Propuesta comercial',lines:[`Subtotal: ${dollars(quote.snapshot.subtotal)}`,
        `Descuento: ${dollars(quote.snapshot.discount)}`,`Total antes de impuestos: ${dollars(quote.snapshot.total)}`,
        'El tratamiento de impuestos debe validarse antes de emitir documentos fiscales.']},
    ]};
}

export async function createBusinessPdf(content:DocumentContent,fontBytes:Uint8Array):Promise<Uint8Array>{
  const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);
  const font=await pdf.embedFont(fontBytes,{subset:true});
  const characters=new Set(font.getCharacterSet());
  for(const text of [content.title,content.reference,...content.sections.flatMap(section=>[section.heading,...section.lines])]){
    if([...text].some(char=>!['\n','\r','\t'].includes(char)&&!characters.has(char.codePointAt(0)!))){
      throw new Error('La fuente del documento no admite un carácter del contenido. No se alteraron los datos originales.');
    }
  }
  pdf.setTitle(content.title);pdf.setAuthor('AJ Rent a Car');pdf.setLanguage('es-SV');
  pdf.setCreationDate(new Date(content.createdAt));pdf.setModificationDate(new Date(content.createdAt));
  let page=pdf.addPage([612,792]);let y=0;
  function header(){
    page.drawRectangle({x:0,y:780,width:612,height:12,color:rgb(.9,.16,.25)});
    page.drawText('AJ RENT A CAR',{x:44,y:745,size:19,font,color:rgb(.06,.1,.19)});
    page.drawText(content.title,{x:44,y:716,size:14,font,color:rgb(.14,.22,.35)});y=688;
  }
  header();
  function line(text:string,size=10){
    if(y<70){page=pdf.addPage([612,792]);header();}
    page.drawText(text,{x:44,y,size,font,color:rgb(.14,.2,.3)});y-=size+6;
  }
  function wrap(text:string,size=10){
    for(const paragraph of text.replaceAll('\t',' ').split(/\r?\n/)){
      let buffer='';
      for(const character of paragraph){
        if(font.widthOfTextAtSize(buffer+character,size)>524){line(buffer,size);buffer='';}
        buffer+=character;
      }
      line(buffer,size);
    }
  }
  wrap(content.reference,8);y-=12;
  for(const section of content.sections){
    if(y<120){page=pdf.addPage([612,792]);header();}
    wrap(section.heading,12);y-=5;
    for(const text of section.lines)wrap(text);
    y-=16;
  }
  pdf.getPages().forEach((sheet,index)=>{
    sheet.drawText('Documento operativo. No sustituye un comprobante fiscal.',{x:44,y:35,size:7,font,color:rgb(.4,.45,.53)});
    sheet.drawText(`${index+1} / ${pdf.getPageCount()}`,{x:535,y:35,size:8,font,color:rgb(.4,.45,.53)});
  });
  return pdf.save();
}

export async function browserFont():Promise<Uint8Array>{
  const response=await fetch('/fonts/manrope-latin-regular.woff');
  if(!response.ok)throw new Error('No se pudo cargar la tipografía local del PDF.');
  return new Uint8Array(await response.arrayBuffer());
}
export function bytesToBase64(bytes:Uint8Array):string{
  let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(binary);
}
export function downloadPdf(base64:string,name:string):void{
  const bytes=Uint8Array.from(atob(base64.replaceAll('\n','')),char=>char.charCodeAt(0));
  const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
  link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}
