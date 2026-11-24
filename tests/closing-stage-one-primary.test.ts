import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Regression guard for the audit findings F3/F10 (closing stage): a screen shows
// at most ONE primary action. The rental closing stage keeps "Guardar versión de
// contrato" as its single primary; the shared file upload stays reachable but
// secondary, and the workshop "Fotos y documentos" section keeps its own single
// primary. No command, payload, permission or label meaning changes here.

const source=(path:string)=>readFileSync(path,'utf8');

const caseFiles=source('src/components/templates/vehicle-case-screen.tsx');
const rentalFolio=source('src/components/templates/rental-case-screen.tsx');
const rentalContracts=source('src/components/organisms/rental-contracts.tsx');
const workshopScreen=source('src/components/templates/workshop-case-screen.tsx');

// Extracts every <Button ...> opening tag, ignoring the '>' characters that live
// inside inline handlers such as onClick={()=>doIt()}.
function buttonTags(text:string):string[]{
  const tags:string[]=[];
  for(let index=text.indexOf('<Button');index>=0;){
    let depth=0;let quote='';let end=index;
    for(end=index;end<text.length;end++){
      const char=text[end];
      if(quote){
        if(char===quote)quote='';
        continue;
      }
      if(char==='"'||char==="'"){quote=char;continue;}
      if(char==='{'||char==='('||char==='[')depth++;
      else if(char==='}'||char===')'||char===']')depth--;
      else if(char==='>'&&depth===0){break;}
    }
    tags.push(text.slice(index,end+1));
    index=text.indexOf('<Button',end+1);
  }
  return tags;
}
// A button is secondary when it declares a non-primary variant; anything else
// keeps the component default variant, which is the brand-red primary.
function primaryButtons(text:string):string[]{
  return buttonTags(text).filter(tag=>!/variant\s*=\s*(?:"(?:outline|ghost|destructive)"|\{'outline'\})/.test(tag));
}

const closingStage=(()=>{
  const start=rentalFolio.indexOf('shown===4&&<>');
  const end=rentalFolio.indexOf('{(error||loadError)',start);
  assert.ok(start>=0&&end>start,'the closing stage block is present');
  return rentalFolio.slice(start,end);
})();

test('the rental closing stage renders exactly one primary action',()=>{
  // The stage itself adds no primary of its own (the expense button is secondary).
  assert.equal(primaryButtons(closingStage).length,0);
  // The contract version is the meaningful business action and stays primary.
  const contractPrimaries=primaryButtons(rentalContracts);
  assert.equal(contractPrimaries.length,1);
  assert.match(contractPrimaries[0],/type="submit"/);
  assert.ok(rentalContracts.includes('<Button type="submit" disabled={busy}>Guardar versión de contrato</Button>'));
  // The shared upload is secondary in this scope, so it does not compete.
  assert.ok(caseFiles.includes("uploadVariant=submitVariant??(reservationId?'outline':'default')"));
  assert.ok(caseFiles.includes('<Button type="submit" variant={uploadVariant}'));
  const total=primaryButtons(closingStage).length+contractPrimaries.length;
  assert.equal(total,1,'the closing stage keeps exactly one primary action');
});

test('the shared file upload stays fully functional after being demoted',()=>{
  assert.ok(caseFiles.includes('Guardar archivo en este expediente'),'the label is unchanged');
  assert.ok(caseFiles.includes('<Button type="submit" variant={uploadVariant} disabled={busy}>'),'the submit stays enabled by the same busy guard');
  // Same input, same payload and same RPC call: the demotion is visual only.
  assert.ok(caseFiles.includes('accept="image/png,image/jpeg,image/webp,application/pdf"'));
  assert.ok(caseFiles.includes('const payload={vehicleId:file.vehicle.id,orderId:orderId??null,reservationId:reservationId??null,purpose:String(f.get(\'purpose\')),financial:f.has(\'financial\')}'));
  assert.ok(caseFiles.includes('uploadVehicleFile(upload,payload,key)'));
  assert.ok(caseFiles.includes('required accept="image/png,image/jpeg,image/webp,application/pdf"'));
});

test('the workshop folio keeps exactly one primary in each action stage',()=>{
  // The folio itself offers no primary button outside its stages, and the budget
  // stage keeps exactly one: create or edit the budget in place.
  const screenPrimary=primaryButtons(workshopScreen);
  assert.equal(screenPrimary.length,2,'only the budget and the empty approval stage carry one');
  const budget=workshopScreen.slice(workshopScreen.indexOf("{section==='budget'"),workshopScreen.indexOf("{section==='approval'"));
  assert.equal(primaryButtons(budget).length,1);
  // Its documents section renders the same upload for the same workshop scope,
  // where no other primary competes: the upload remains the single primary.
  assert.ok(workshopScreen.includes("{section==='documents'&&filesSlot}"));
  assert.ok(rentalFolio.includes('<CaseFiles file={file} reservationId={id} onChange={reload}/>'));
  assert.ok(caseFiles.includes("<CaseFiles file={sanitizedDossierFile(file,can('expenses.read'))} orderId={job.id} onChange={onChange}/>"));
  // The scope that keeps the upload primary is the one without a reservation.
  assert.ok(caseFiles.includes("submitVariant??(reservationId?'outline':'default')"));
});
