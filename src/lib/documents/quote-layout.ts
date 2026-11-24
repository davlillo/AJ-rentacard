import {rgb,type PDFDocument,type PDFFont,type PDFPage} from 'pdf-lib';

export interface PrintedQuote {
  customer:string;document:string;vehicle:string;plate:string;status:string;
  lines:{description:string;quantity:number;unitPrice:number;amount:number}[];
  subtotal:number;discount:number;total:number;
}
const ink=rgb(.12,.17,.24),muted=rgb(.39,.44,.51),red=rgb(.84,.14,.22),paper=rgb(.96,.97,.98),line=rgb(.88,.90,.93);
const dollars=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);

function wrap(font:PDFFont,text:string,width:number,size:number):string[]{
  const rows:string[]=[];
  for(const paragraph of String(text??'').split(/\r?\n/)){
    let rest=paragraph;
    while(rest&&font.widthOfTextAtSize(rest,size)>width){
      let end=1;while(end<rest.length&&font.widthOfTextAtSize(rest.slice(0,end+1),size)<=width)end++;
      const space=rest.lastIndexOf(' ',end);const cut=space>0?space:end;
      rows.push(rest.slice(0,cut));rest=rest.slice(cut).trimStart();
    }
    rows.push(rest);
  }
  return rows;
}

export function drawQuotePdf(pdf:PDFDocument,font:PDFFont,quote:PrintedQuote,reference:string,createdAt:string):void{
  let page!:PDFPage;let y=0;
  const text=(value:string,x:number,top:number,size=10,color=ink)=>page.drawText(value,{x,y:top,font,size,color});
  const right=(value:string,x:number,top:number,size=10,color=ink)=>text(value,x-font.widthOfTextAtSize(value,size),top,size,color);
  function start(){
    page=pdf.addPage([612,792]);
    page.drawRectangle({x:0,y:692,width:612,height:100,color:ink});
    page.drawRectangle({x:44,y:713,width:4,height:43,color:red});
    text('AJ',59,733,29,rgb(1,1,1));text('RENT A CAR',111,739,12,rgb(1,1,1));
    text('Rentas y taller',112,719,8,rgb(.76,.80,.85));
    right('PRESUPUESTO DE SERVICIO',568,745,10,rgb(.80,.84,.89));
    right(reference,568,723,10,rgb(1,1,1));
    text('Fecha de emisión',44,664,8,muted);
    text(new Date(createdAt).toLocaleDateString('es-SV',{day:'2-digit',month:'long',year:'numeric',timeZone:'America/El_Salvador'}),44,648,10);
    right(quote.status.toUpperCase(),568,651,10,red);y=618;
  }
  function columns(){
    page.drawRectangle({x:44,y:y-28,width:524,height:28,color:paper});
    text('DESCRIPCIÓN',56,y-18,8,muted);right('CANT.',365,y-18,8,muted);
    right('PRECIO UNIT.',466,y-18,8,muted);right('IMPORTE',556,y-18,8,muted);y-=28;
  }
  start();
  const client=wrap(font,quote.customer||'Cliente sin registrar',230,12);
  const vehicle=wrap(font,quote.vehicle,230,12);
  const cardHeight=Math.max(client.length,vehicle.length)*16+58;
  page.drawRectangle({x:44,y:y-cardHeight,width:252,height:cardHeight,color:paper});
  page.drawRectangle({x:308,y:y-cardHeight,width:260,height:cardHeight,color:paper});
  text('PREPARADO PARA',57,y-19,8,muted);client.forEach((row,i)=>text(row,57,y-40-i*16,12));
  if(quote.document)text(quote.document,57,y-cardHeight+13,9,muted);
  text('VEHÍCULO',321,y-19,8,muted);vehicle.forEach((row,i)=>text(row,321,y-40-i*16,12));
  text(quote.plate,321,y-cardHeight+13,9,muted);y-=cardHeight+15;
  text('Detalle del servicio',44,y,12);y-=15;columns();
  for(const item of quote.lines){
    const description=wrap(font,item.description,270,9.5);const height=Math.max(29,description.length*13+14);
    if(y-height<70){start();text('Detalle del servicio · continuación',44,y,10,muted);y-=16;columns();}
    description.forEach((row,i)=>text(row,56,y-18-i*13,9.5));
    right(String(item.quantity),365,y-18,9.5);right(dollars(item.unitPrice),466,y-18,9.5);right(dollars(item.amount),556,y-18,9.5);
    y-=height;page.drawLine({start:{x:44,y},end:{x:568,y},thickness:.5,color:line});
  }
  if(y<195)start();else y-=28;
  text('Subtotal',355,y,10,muted);right(dollars(quote.subtotal),556,y,10);y-=24;
  text('Descuento',355,y,10,muted);right(dollars(quote.discount),556,y,10);y-=19;
  page.drawRectangle({x:342,y:y-54,width:226,height:54,color:ink});
  text('TOTAL · USD',355,y-21,9,rgb(.80,.84,.89));right(dollars(quote.total),555,y-37,20,rgb(1,1,1));
  text('Sobre este presupuesto',44,y+43,10);
  const notes=wrap(font,'Este documento presenta el alcance y precio del servicio. No acredita un pago recibido ni sustituye un comprobante fiscal. El tratamiento de impuestos debe validarse antes de la emisión fiscal.',255,8.5);
  notes.forEach((row,i)=>text(row,44,y+24-i*13,8.5,muted));
  pdf.getPages().forEach((sheet,index)=>{
    sheet.drawLine({start:{x:44,y:49},end:{x:568,y:49},thickness:.5,color:line});
    sheet.drawText('AJ RENT A CAR · Presupuesto de servicio',{x:44,y:33,font,size:8,color:muted});
    const number=`${index+1} / ${pdf.getPageCount()}`;
    sheet.drawText(number,{x:568-font.widthOfTextAtSize(number,8),y:33,font,size:8,color:muted});
  });
}
