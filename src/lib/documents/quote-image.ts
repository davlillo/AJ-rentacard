import type {DocumentContent} from './pdf';

const ink='#26354a',muted='#65758a',red='#d72439',paper='#f5f7fa';
const dollars=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);

// Render only the same client-facing projection as the PDF, never the operational DOM.
export async function createQuoteImages(content:DocumentContent):Promise<Blob[]>{
  const quote=content.quote;if(!quote)throw new Error('El presupuesto no tiene un contenido exportable.');
  await document.fonts.ready;
  const canvas=document.createElement('canvas');const measured=canvas.getContext('2d');
  if(!measured)throw new Error('El navegador no pudo generar la imagen.');
  const context=measured;
  type Drawing={kind:'text';value:string;x:number;y:number;size:number;color:string;align:CanvasTextAlign;bold:boolean}|
    {kind:'rectangle';x:number;y:number;width:number;height:number;color:string};
  const pages:Drawing[][]=[];let drawing:Drawing[]=[];let y=0;
  function text(value:string,x:number,top:number,size=11,color=ink,align:CanvasTextAlign='left',bold=false){
    drawing.push({kind:'text',value,x,y:top,size,color,align,bold});
  }
  function rectangle(x:number,top:number,width:number,height:number,color:string){drawing.push({kind:'rectangle',x,y:top,width,height,color});}
  function wrap(value:string,width:number,size=11):string[]{
    context.font=`400 ${size}px Manrope, sans-serif`;const rows:string[]=[];
    for(const paragraph of String(value??'').split(/\r?\n/)){
      let line='';for(const character of paragraph){if(line&&context.measureText(line+character).width>width){rows.push(line);line='';}line+=character;}rows.push(line);
    }
    return rows;
  }
  function start(){
    drawing=[];pages.push(drawing);
    rectangle(0,0,612,792,'#fff');rectangle(0,0,612,100,ink);
    rectangle(36,28,4,44,red);text('AJ',49,59,29,'#fff','left',true);
    text('RENT A CAR',101,47,12,'#fff','left',true);text('Rentas y taller',102,66,9,'#cbd5e1');
    text('PRESUPUESTO DE SERVICIO',576,40,10,'#cbd5e1','right');text(content.reference,576,64,10,'#fff','right');
    text(new Date(content.createdAt).toLocaleDateString('es-SV',{timeZone:'America/El_Salvador'}),36,126,10,muted);
    text(quote!.status.toUpperCase(),576,126,10,red,'right',true);y=151;
  }
  function columns(){rectangle(36,y,540,29,paper);
    text('DESCRIPCIÓN',47,y+19,9,muted);text('CANT.',375,y+19,9,muted,'right');
    text('PRECIO UNIT.',478,y+19,9,muted,'right');text('IMPORTE',565,y+19,9,muted,'right');y+=29;}
  start();
  const client=wrap(quote.customer||'Cliente sin registrar',240,13),vehicle=wrap(quote.vehicle,240,13);
  // Long identity fields wrap without clipping the service detail.
  text('PREPARADO PARA',36,y,9,muted);text('VEHÍCULO',316,y,9,muted);y+=22;
  for(let index=0;index<Math.max(client.length,vehicle.length);index++){
    if(y>650){start();}if(client[index])text(client[index],36,y,13);if(vehicle[index])text(vehicle[index],316,y,13);y+=18;
  }
  const identities=[wrap(quote.document||'Documento sin registrar',240,10),wrap(quote.plate,240,10)];
  for(let index=0;index<Math.max(...identities.map(rows=>rows.length));index++){
    text(identities[0][index]??'',36,y,10,muted);text(identities[1][index]??'',316,y,10,muted);y+=15;
  }
  y+=22;columns();
  for(const item of quote.lines){
    const description=wrap(item.description,285,10.5);let first=true;
    while(description.length){
      if(y+31>690){start();columns();}
      const count=Math.min(description.length,Math.max(1,Math.floor((690-y-14)/15)));
      const chunk=description.splice(0,count);const height=Math.max(32,chunk.length*15+14);
      chunk.forEach((line,index)=>text(line,47,y+19+index*15,10.5));
      if(first){text(String(item.quantity),375,y+19,10.5,ink,'right');text(dollars(item.unitPrice),478,y+19,10.5,ink,'right');text(dollars(item.amount),565,y+19,10.5,ink,'right');first=false;}
      y+=height;rectangle(36,y,540,.6,'#e3e8ef');
    }
  }
  if(y>550)start();else y+=25;
  text('Subtotal',360,y,11,muted);text(dollars(quote.subtotal),565,y,11,ink,'right');y+=26;
  text('Descuento',360,y,11,muted);text(dollars(quote.discount),565,y,11,ink,'right');y+=18;
  rectangle(346,y,230,60,ink);text('TOTAL · USD',360,y+22,10,'#cbd5e1');text(dollars(quote.total),565,y+46,22,'#fff','right',true);
  y+=86;wrap('Este documento presenta el alcance y precio del servicio. No acredita un pago recibido ni sustituye un comprobante fiscal.',540,9)
    .forEach((line,index)=>text(line,36,y+index*14,9,muted));
  const images:Blob[]=[];
  // Reuse one bitmap; a long quote must not retain hundreds of full-resolution canvases.
  for(const [index,page] of pages.entries()){
    canvas.width=1224;canvas.height=1584;context.scale(2,2);
    for(const item of page){context.fillStyle=item.color;
      if(item.kind==='rectangle')context.fillRect(item.x,item.y,item.width,item.height);
      else{context.font=`${item.bold?'700':'400'} ${item.size}px Manrope, sans-serif`;context.textAlign=item.align;context.fillText(item.value,item.x,item.y);}
    }
    context.fillStyle=muted;context.font='400 9px Manrope, sans-serif';context.textAlign='left';
    context.fillText('AJ RENT A CAR · Presupuesto de servicio',36,758);context.textAlign='right';context.fillText(`${index+1} / ${pages.length}`,576,758);
    images.push(await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo generar la imagen.')),'image/png')));
  }
  canvas.width=0;canvas.height=0;
  return images;
}
export async function downloadQuoteImages(content:DocumentContent,name:string):Promise<void>{
  const images=await createQuoteImages(content);
  for(const [index,image] of images.entries()){
    const link=document.createElement('a');const url=URL.createObjectURL(image);link.href=url;
    link.download=`${name}${images.length>1?`-${index+1}`:''}.png`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}
