import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PDFDocument} from 'pdf-lib';
import {createBusinessPdf,quoteDocumentContent} from '../src/lib/documents/pdf';
import type {QuoteVersion} from '../src/lib/supabase/estimates';

test('HU08 client PDF uses only frozen customer/prices, never internal costs, and handles page breaks',async()=>{
  const quote={id:'test-version',order_id:'OT-TEST',folio_number:25,revision:1,status:'Aprobado',created_at:'2026-10-22T12:00:00Z',
    customer_snapshot:{name:'José Pérez',document:'DOC-1'},vehicle_snapshot:{brand:'Test',model:'Car',plate:'P123'},
    snapshot:{method:'commercial',subtotal:42,discount:0,total:42,cost:9999,margin:-9957,lines:[
      {description:'Pintura y preparación',quantity:1,price:42,unitCost:9999},
    ]}} as QuoteVersion;
  const content=quoteDocumentContent(quote);
  assert.equal(content.reference,'PRE-00025 · Versión 1');
  assert.ok(!JSON.stringify(content).includes('test-version'));
  assert.ok(!JSON.stringify(content).includes('9999'));
  assert.ok(JSON.stringify(content).includes('José Pérez'));
  const bytes=await createBusinessPdf({...content,sections:[...content.sections,
    {heading:'Scope continued',lines:Array.from({length:100},(_,index)=>`Line ${index+1}: `+'Detail '.repeat(30))}]},
    readFileSync('public/fonts/manrope-latin-regular.woff'));
  assert.equal(Buffer.from(bytes.subarray(0,5)).toString(),'%PDF-');
  const pdf=await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount()>1);assert.equal(pdf.getTitle(),'Presupuesto de servicio');
});
