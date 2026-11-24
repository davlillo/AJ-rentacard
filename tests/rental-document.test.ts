import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PDFDocument} from 'pdf-lib';
import {rentalAmountRows,rentalDateLabel,rentalDocument,rentalDocumentFileName,type RentalDocumentFacts} from '../src/lib/documents/rental-document';
import {rentalDocumentContent,rentalFontSupport,rentalSections,renderRentalPdf,sanitizeForFont} from '../src/lib/documents/rental-layout';
import {rentalImagePages} from '../src/lib/documents/rental-image';

const fontBytes=()=>new Uint8Array(readFileSync('public/fonts/manrope-latin-regular.woff'));

const facts:RentalDocumentFacts={
  folioNumber:42,customerName:'José Pérez',vehicleLabel:'Nissan Rogue 2018',plate:'P-123-ABC',
  startsOn:'2026-11-01',endsOn:'2026-11-05',days:5,agreedAmount:250,issuedAmount:150,appliedAmount:100,
  pendingAmount:50,openEnded:false,statusLabel:'Confirmada',createdAt:'2026-11-20T10:00:00Z',
};

test('an open rental shows no agreed total and no invented day count',()=>{
  const document=rentalDocument({...facts,openEnded:true,agreedAmount:0,days:null});
  assert.equal(document.openEnded,true);
  assert.equal(document.agreedAmount,null);
  assert.equal(document.days,null);
  const agreed=rentalAmountRows(document).find(row=>row.key==='agreed');
  assert.equal(agreed?.value,'Sin total acordado');
  assert.ok(!rentalSections(document).some(section=>section.lines.some(line=>line.includes('Días: 0'))));
});

test('a rental without dates stays renderable and says the date is unknown',()=>{
  const document=rentalDocument({...facts,startsOn:null,endsOn:null,days:null});
  assert.equal(document.startsOn,'');
  assert.equal(document.days,null);
  const period=rentalSections(document).find(section=>section.heading==='Período acordado');
  assert.ok(period?.lines.includes('Inicio: Sin fecha de inicio'));
  assert.ok(period?.lines.includes('Fin: Sin fecha de fin'));
  assert.ok(period?.lines.includes('Días: Sin definir'));
  assert.equal(rentalDateLabel(''),'');
});

test('the agreed, issued, applied and pending amounts stay separated',()=>{
  const document=rentalDocument(facts);
  const rows=rentalAmountRows(document);
  const values=rows.map(row=>row.value);
  assert.equal(new Set(values).size,4);
  assert.ok(rows.find(row=>row.key==='agreed')?.value.includes('250.00'));
  assert.ok(rows.find(row=>row.key==='issued')?.value.includes('150.00'));
  assert.ok(rows.find(row=>row.key==='applied')?.value.includes('100.00'));
  assert.ok(rows.find(row=>row.key==='pending')?.value.includes('50.00'));
  assert.ok(!rows.find(row=>row.key==='agreed')?.value.includes('150.00'));
  const derived=rentalDocument({...facts,pendingAmount:null});
  assert.equal(rentalAmountRows(derived).find(row=>row.key==='pending')?.value.includes('50.00'),true);
});

test('the projection ignores internal cost, margin and operator fields',()=>{
  const document=rentalDocument({...facts,cost:9999,margin:-9000,operator:'Tecnico interno',
    internalReason:'ajuste de margen',sellerName:'Vendedor interno'} as unknown as RentalDocumentFacts);
  const serialized=JSON.stringify(document);
  assert.ok(!serialized.includes('9999'));
  assert.ok(!serialized.includes('-9000'));
  assert.ok(!serialized.includes('Tecnico'));
  assert.ok(!serialized.includes('margen'));
  assert.equal(Object.keys(document).sort().join(','),
    ['agreedAmount','appliedAmount','createdAt','customerName','days','endsOn','folioNumber','issuedAmount','openEnded','pendingAmount','plate','startsOn','statusLabel','vehicleLabel'].join(','));
});

test('every character rendered in the detail is covered by the PDF font subset',async()=>{
  const supported=await rentalFontSupport(fontBytes());
  const content=rentalDocumentContent(rentalDocument(facts));
  const rendered=[content.title,content.reference,...content.sections.flatMap(section=>[section.heading,...section.lines])];
  const missing=rendered.flatMap(text=>[...text]).filter(char=>!supported.has(char.codePointAt(0)!));
  assert.deepEqual(missing,[]);
  for(const char of ['á','é','í','ó','ú','ñ','¿','¡','—','·','%','$'])assert.ok(supported.has(char.codePointAt(0)!),`missing ${char}`);
  const full=new Set([...'Vehículo · ñ'].map(char=>char.codePointAt(0)!));
  assert.equal(sanitizeForFont('Vehículo · ñ',full),'Vehículo · ñ');
  assert.equal(sanitizeForFont('á',new Set()),'a');
});

test('the rental detail renders PDF bytes without touching any API',async()=>{
  const bytes=await renderRentalPdf(rentalDocument(facts),fontBytes());
  assert.equal(Buffer.from(bytes.subarray(0,5)).toString(),'%PDF-');
  const pdf=await PDFDocument.load(bytes);
  assert.equal(pdf.getTitle(),'DETALLE DE ALQUILER');
  assert.equal(pdf.getPageCount(),1);
});

test('the PNG renderer produces image bytes through the shared drawing plan',async()=>{
  const document=rentalDocument(facts);
  const pages=rentalImagePages(document);
  assert.equal(pages.length,1);
  const texts=pages[0].ops.filter(op=>op.kind==='text').map(op=>op.value??'');
  assert.ok(texts.includes('DETALLE DE ALQUILER'));
  assert.ok(texts.some(text=>text.startsWith('Cliente: José Pérez')));
  const context={font:'',fillStyle:'',textAlign:'left',calls:0,scale(){this.calls++;},fillRect(){this.calls++;},
    fillText(){this.calls++;},measureText(value:string){return {width:value.length*6};}};
  const bytes=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
  const blob={size:bytes.length,type:'image/png',bytes};
  const previous=globalThis.document;
  (globalThis as unknown as {document:unknown}).document={
    fonts:{ready:Promise.resolve()},
    createElement:()=>({width:0,height:0,getContext:()=>context,toBlob:(callback:(value:unknown)=>void)=>callback(blob)}),
  };
  try{
    const {createRentalImages}=await import('../src/lib/documents/rental-image');
    const images=await createRentalImages(document);
    assert.equal(images.length,1);
    assert.ok(images[0].size>0);
    assert.equal((images[0] as unknown as {bytes:Uint8Array}).bytes[0],0x89);
    assert.equal(String.fromCharCode(...(images[0] as unknown as {bytes:Uint8Array}).bytes.subarray(1,4)),'PNG');
    assert.ok(context.calls>0);
  }finally{
    (globalThis as unknown as {document:unknown}).document=previous;
  }
});

test('the PDF sections and the PNG plan share the same labels',()=>{
  const document=rentalDocument(facts);
  const lines=rentalSections(document).flatMap(section=>[section.heading,...section.lines]);
  const texts=rentalImagePages(document)[0].ops.filter(op=>op.kind==='text').map(op=>op.value??'');
  for(const line of lines)assert.ok(texts.some(text=>text.startsWith(line.slice(0,24))),`missing label ${line}`);
});

test('the detail states that the agreed amount is the agreement and not a receivable',()=>{
  const document=rentalDocument(facts);
  const agreed=rentalAmountRows(document).find(row=>row.key==='agreed');
  assert.ok(agreed?.note,'the agreed row must carry its exact meaning');
  assert.match(agreed!.note!,/no es una cuenta por cobrar emitida/);
  // The same projection feeds the PDF content and the PNG plan.
  const importes=rentalSections(document).find(section=>section.heading==='Importes');
  assert.ok(importes?.lines.some(line=>line===agreed!.note));
  const pdfLines=rentalDocumentContent(document).sections.flatMap(section=>section.lines);
  assert.ok(pdfLines.some(line=>/no es una cuenta por cobrar emitida/.test(line)));
  const plan=rentalImagePages(document)[0].ops.filter(op=>op.kind==='text').map(op=>op.value??'').join(' ');
  assert.ok(plan.includes('no es una cuenta por cobrar emitida'),'the PNG plan misses the agreed qualifier');
  assert.ok(!plan.includes('Monto acordado: $250.00. es el monto'),'the qualifier must not be glued to the amount');
});

test('the download filename carries the folio',()=>{
  const document=rentalDocument(facts);
  assert.equal(document.folioNumber,'ALQ-00042');
  assert.equal(rentalDocumentFileName(document),'detalle-ALQ-00042');
});
