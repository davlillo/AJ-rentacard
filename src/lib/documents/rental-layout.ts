import {browserFont,createBusinessPdf,type DocumentContent} from './pdf';
import {rentalAmountRows,rentalDateLabel,type RentalDocument} from './rental-document';

export const rentalBrand={company:'AJ RENT A CAR',tagline:'Rentas y taller',title:'DETALLE DE ALQUILER'};
export const rentalPalette={ink:'#26354a',muted:'#65758a',red:'#d72439',paper:'#f5f7fa',line:'#e3e8ef'};

export interface RentalSection{heading:string;lines:string[]}

// One label model: the PDF and the PNG render exactly these headings and lines.
export function rentalSections(document:RentalDocument):RentalSection[]{
  const amounts=rentalAmountRows(document);
  const amountLines:string[]=[];
  for(const row of amounts){
    amountLines.push(`${row.label}: ${row.value}`);
    if(row.note)amountLines.push(row.note);
  }
  const sections:RentalSection[]=[
    {heading:'Cliente y vehículo',lines:[
      `Cliente: ${document.customerName}`,
      `Vehículo: ${document.vehicleLabel}`,
      ...(document.plate?[`Placa: ${document.plate}`]:[]),
    ]},
    {heading:'Período acordado',lines:[
      `Inicio: ${rentalDateLabel(document.startsOn)||'Sin fecha de inicio'}`,
      `Fin: ${rentalDateLabel(document.endsOn)||'Sin fecha de fin'}`,
      `Días: ${document.days===null?'Sin definir':document.days}`,
    ]},
    {heading:'Importes',lines:amountLines},
    {heading:'Estado',lines:[`Estado: ${document.statusLabel}`]},
    {heading:'Sobre este documento',lines:[
      'Documento informativo generado a la demanda. No es un contrato ni un comprobante fiscal.',
      'No acredita pagos ni aceptación de condiciones. Los importes emitidos y aplicados son los registrados en el folio al momento de generar el detalle.',
    ]},
  ];
  return sections;
}

export function rentalDocumentContent(document:RentalDocument):DocumentContent{
  return{
    title:rentalBrand.title,
    reference:`${document.folioNumber} · Documento informativo`,
    createdAt:document.createdAt,
    sections:rentalSections(document),
  };
}

// The PDF engine refuses characters the font subset cannot draw, so the subset is inspected before rendering.
export async function rentalFontSupport(fontBytes:Uint8Array):Promise<Set<number>>{
  const {PDFDocument}=await import('pdf-lib');
  const fontkit=(await import('@pdf-lib/fontkit')).default;
  const probe=await PDFDocument.create();
  probe.registerFontkit(fontkit);
  const font=await probe.embedFont(fontBytes,{subset:true});
  return new Set(font.getCharacterSet());
}

const folded:Record<string,string>={'á':'a','é':'e','í':'i','ó':'o','ú':'u','ü':'u','ñ':'n','Á':'A','É':'E','Í':'I','Ó':'O','Ú':'U','Ü':'U','Ñ':'N','¿':'?','¡':'!','—':'-','–':'-','·':'-','“':'"','”':'"','‘':"'",'’':"'"};

// Unsupported characters fall back to a readable ASCII equivalent instead of breaking the download.
export function sanitizeForFont(value:string,supported:Set<number>):string{
  return [...value].map(char=>{
    const code=char.codePointAt(0)!;
    if(code<32||supported.has(code))return char;
    return folded[char]??(code>127?'?':char);
  }).join('');
}

export async function rentalFontBytes():Promise<Uint8Array>{
  return browserFont();
}

export async function renderRentalPdf(document:RentalDocument,fontBytes:Uint8Array):Promise<Uint8Array>{
  const supported=await rentalFontSupport(fontBytes);
  const content=rentalDocumentContent(document);
  const safe:DocumentContent={
    ...content,
    title:sanitizeForFont(content.title,supported),
    reference:sanitizeForFont(content.reference,supported),
    sections:content.sections.map(section=>({heading:sanitizeForFont(section.heading,supported),
      lines:section.lines.map(line=>sanitizeForFont(line,supported))})),
  };
  return createBusinessPdf(safe,fontBytes);
}
