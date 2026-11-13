import {createSupabaseBrowserClient} from './client';

export interface CustomerDocument {
  id:string;customer_id:string;kind:'DUI'|'Licencia';name:string;mime:string;size:number;created_at:string;
}
const messages:Record<string,string>={PERMISSION_DENIED:'No tiene permiso para consultar documentos personales.',
  INVALID_CUSTOMER_DOCUMENT:'Use una foto PNG, JPEG o WebP válida de hasta 2 MB después de optimizarla.',
  INVALID_CUSTOMER:'La ficha del cliente ya no está activa.',CUSTOMER_DOCUMENT_NOT_FOUND:'No se encontró esta foto.',
  IDEMPOTENCY_CONFLICT:'La solicitud cambió. Cierre y vuelva a abrir la ficha antes de reintentar.'};
async function documentRpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const {data,error}=await createSupabaseBrowserClient().rpc(name,args);
  if(error)throw new Error(messages[error.message]??'No se pudo completar la operación del documento. Revise la conexión.');
  return data as T;
}
export function loadCustomerDocuments(customerId:string):Promise<CustomerDocument[]>{
  return documentRpc('customer_document_list',{customer_id:customerId});
}
export async function uploadCustomerDocument(file:File,customerId:string,kind:CustomerDocument['kind'],key:string):Promise<CustomerDocument>{
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size===0||file.size>12582912)
    throw new Error('Seleccione una foto PNG, JPEG o WebP de hasta 12 MB.');
  // Re-encode locally: strip camera metadata and fit full-resolution phone photos to a private 2 MB record.
  const image=await createImageBitmap(file);
  const canvas=document.createElement('canvas');
  const scale=Math.min(1,1600/Math.max(image.width,image.height));
  canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
  const context=canvas.getContext('2d');
  if(!context){image.close();throw new Error('El navegador no pudo preparar la foto.');}
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);image.close();
  const photo=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo optimizar la foto.')),'image/jpeg',.85));
  if(photo.size>2097152)throw new Error('La foto optimizada supera 2 MB. Pruebe con una imagen de menor tamaño.');
  const {bytesToBase64}=await import('@/lib/documents/pdf');
  return documentRpc('save_customer_document',{payload:{customerId,kind,name:`${kind}.jpg`,mime:'image/jpeg',
    base64:bytesToBase64(new Uint8Array(await photo.arrayBuffer()))},idempotency_key:key});
}
export async function readCustomerDocument(id:string):Promise<Blob>{
  const content=await documentRpc<{mime:string;base64:string}>('customer_document_content',{file_id:id});
  const bytes=Uint8Array.from(atob(content.base64.replace(/\s/g,'')),character=>character.charCodeAt(0));
  return new Blob([bytes],{type:content.mime});
}
