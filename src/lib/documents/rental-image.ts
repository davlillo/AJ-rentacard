import {rentalDateLabel,type RentalDocument} from './rental-document';
import {rentalBrand,rentalPalette,rentalSections} from './rental-layout';

export interface RentalImageOp {
  kind:'rect'|'text';
  x:number;y:number;
  width?:number;height?:number;
  value?:string;size?:number;color?:string;align?:CanvasTextAlign;bold?:boolean;
}
export interface RentalImagePage{ops:RentalImageOp[]}
export type RentalTextMeasure=(value:string,size:number)=>number;

const pageWidth=612,pageHeight=792,margin=36;
const approx=(value:string,size:number):number=>value.length*size*0.55;

// The drawing plan is pure so both the browser renderer and the tests share the same labels.
export function rentalImagePages(document:RentalDocument,measure?:RentalTextMeasure):RentalImagePage[]{
  const width=measure??approx;
  const pages:RentalImagePage[]=[];let ops:RentalImageOp[]=[];
  const text=(value:string,x:number,y:number,size=10.5,color=rentalPalette.ink,align:CanvasTextAlign='left',bold=false)=>{
    ops.push({kind:'text',x,y,value,size,color,align,bold});
  };
  const rect=(x:number,y:number,w:number,h:number,color:string)=>{ops.push({kind:'rect',x,y,width:w,height:h,color});};
  const wrap=(value:string,max:number,size:number):string[]=>{
    const rows:string[]=[];
    for(const paragraph of String(value??'').split(/\r?\n/)){
      let line='';
      for(const character of paragraph){
        if(line&&width(line+character,size)>max){rows.push(line);line='';}
        line+=character;
      }
      rows.push(line);
    }
    return rows;
  };
  const start=()=>{
    ops=[];pages.push({ops});
    rect(0,0,pageWidth,pageHeight,'#ffffff');
    rect(0,0,pageWidth,100,rentalPalette.ink);
    rect(36,28,4,44,rentalPalette.red);
    text('AJ',49,59,29,'#ffffff','left',true);
    text('RENT A CAR',101,47,12,'#ffffff','left',true);
    text(rentalBrand.tagline,102,66,9,'#cbd5e1');
    text(rentalBrand.title,576,40,10,'#cbd5e1','right');
    text(document.folioNumber,576,64,10,'#ffffff','right');
    text(rentalDateLabel(document.createdAt.slice(0,10))||'Sin fecha',36,126,10,rentalPalette.muted);
    text(document.statusLabel,576,126,10,rentalPalette.red,'right',true);
  };
  start();
  let y=151;
  for(const section of rentalSections(document)){
    if(y>640){start();y=151;}
    text(section.heading,36,y,12,rentalPalette.ink,'left',true);y+=20;
    for(const line of section.lines){
      for(const row of wrap(line,pageWidth-margin*2-12,10.5)){
        if(y>700){start();y=151;}
        text(row,47,y,10.5,rentalPalette.ink);y+=16;
      }
    }
    y+=16;
  }
  return pages;
}

export async function createRentalImages(document:RentalDocument):Promise<Blob[]>{
  if(typeof globalThis.document==='undefined')throw new Error('El navegador no pudo generar la imagen.');
  const fonts=(globalThis as unknown as {fonts?:{ready?:Promise<unknown>}}).fonts;
  if(fonts?.ready)await fonts.ready;
  const canvas=globalThis.document.createElement('canvas');
  const context=canvas.getContext('2d');
  if(!context)throw new Error('El navegador no pudo generar la imagen.');
  const pages=rentalImagePages(document,(value,size)=>{
    context.font=`400 ${size}px Manrope, sans-serif`;
    return context.measureText(value).width;
  });
  const images:Blob[]=[];
  // One bitmap is reused for every page so a long detail does not retain hundreds of canvases.
  for(const [index,page] of pages.entries()){
    canvas.width=1224;canvas.height=1584;context.scale(2,2);
    for(const op of page.ops){
      if(op.kind==='rect'){
        context.fillStyle=op.color??rentalPalette.ink;
        context.fillRect(op.x,op.y,op.width??0,op.height??0);
        continue;
      }
      context.fillStyle=op.color??rentalPalette.ink;
      context.font=`${op.bold?'700':'400'} ${op.size??10.5}px Manrope, sans-serif`;
      context.textAlign=op.align??'left';
      context.fillText(op.value??'',op.x,op.y);
    }
    context.fillStyle=rentalPalette.muted;context.font='400 9px Manrope, sans-serif';context.textAlign='left';
    context.fillText('AJ RENT A CAR · Detalle de alquiler',36,758);
    context.textAlign='right';context.fillText(`${index+1} / ${pages.length}`,576,758);
    images.push(await new Promise<Blob>((resolve,reject)=>canvas.toBlob(
      blob=>blob?resolve(blob):reject(new Error('No se pudo generar la imagen.')),'image/png')));
  }
  canvas.width=0;canvas.height=0;
  return images;
}

export async function downloadRentalImages(document:RentalDocument,name:string):Promise<void>{
  const images=await createRentalImages(document);
  for(const [index,image] of images.entries()){
    const link=globalThis.document.createElement('a');
    const url=URL.createObjectURL(image);
    link.href=url;link.download=`${name}${images.length>1?`-${index+1}`:''}.png`;
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}
