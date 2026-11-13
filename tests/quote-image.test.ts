import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createQuoteImages} from '../src/lib/documents/quote-image';
import type {DocumentContent} from '../src/lib/documents/pdf';

const content:DocumentContent={title:'Presupuesto',reference:'PRE-00001 · Versión 1',createdAt:'2026-11-09T12:00:00Z',
  sections:[{heading:'Internal calculation must never be rendered',lines:['PRIVATE_COST_SENTINEL']}],quote:{customer:'Test customer',
    document:'',vehicle:'Nissan Test 2020',plate:'TEST-1',status:'Aprobado',
    lines:[{description:'Repair service',quantity:2,unitPrice:45,amount:90}],subtotal:90,discount:5,total:85}};

test('Quote image renders client fields and complete long descriptions with bounded canvas memory',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  const drawn:{text:string;x:number;y:number}[]=[];let canvases=0;
  const context={fillStyle:'',font:'',textAlign:'left',scale:()=>undefined,fillRect:()=>undefined,
    measureText:(value:string)=>({width:[...value].length*6}),
    fillText:(text:string,x:number,y:number)=>drawn.push({text,x,y})};
  const canvas={width:0,height:0,getContext:()=>context,toBlob:(callback:(blob:Blob)=>void)=>callback(new Blob(['encoded page'],{type:'image/png'}))};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{fonts:{ready:Promise.resolve()},
    createElement:()=>{canvases++;return canvas;}}});
  try{
    const images=await createQuoteImages(content);
    assert.equal(images.length,1);assert.equal(images[0].type,'image/png');assert.equal(canvases,1);
    assert.ok(drawn.some(row=>row.text==='Test customer'));assert.ok(drawn.some(row=>row.text==='$85.00'));
    assert.ok(!drawn.some(row=>row.text.includes('PRIVATE_COST_SENTINEL')));
    drawn.length=0;canvases=0;
    const description='LONG_DESCRIPTION_'.repeat(120);
    const long={...content,quote:{...content.quote!,lines:Array.from({length:100},()=>({description,quantity:1,unitPrice:1,amount:1}))}};
    const many=await createQuoteImages(long);
    assert.ok(many.length>10);assert.equal(canvases,1);
    assert.equal(drawn.filter(row=>row.text==='TOTAL · USD').length,1);
    assert.equal(drawn.filter(row=>row.text==='PRESUPUESTO DE SERVICIO').length,many.length);
    assert.ok(drawn.every(row=>row.y>=0&&row.y<=758));
    assert.equal(drawn.filter(row=>row.text.startsWith('LONG')||row.text.includes('DESCRIPTION')||/^[_A-Z]+$/.test(row.text)&&row.text.includes('_'))
      .map(row=>row.text).join('').length,description.length*100);
    assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});

test('Quote image refuses a missing client projection',async()=>{
  await assert.rejects(createQuoteImages({...content,quote:undefined}),/contenido exportable/);
});
