const fs=require('fs');
const files=[
  'tests/browser/redesign_acceptance.py',
  'tests/browser/connected_money_acceptance.py',
  'tests/browser/showcase_transactions.py',
  'tests/browser/rental_workflow_readonly.py',
  'tests/browser/rental_folio_readonly.py',
  'tests/browser/e2e_ui/flow1_cobro.py',
  'tests/browser/e2e_ui/flow2_collect.py',
  'tests/browser/rental_lifecycle_readonly.py',
  'tests/browser/workshop_collections_readonly.py',
  'tests/browser/rental_accounts_readonly.py',
];
const swaps=[
  ["'Destino del abono'","'A qué documento se aplica el cobro'"],
  ['"Destino del abono"','"A qué documento se aplica el cobro"'],
  ["'Importe del abono (USD)'","'Importe recibido (USD)'"],
  ['"Importe del abono (USD)"','"Importe recibido (USD)"'],
  ["'Guardar cobro y aplicar al cargo'","'Guardar cobro y aplicar al documento'"],
  ['"Guardar cobro y aplicar al cargo"','"Guardar cobro y aplicar al documento"'],
];
for(const file of files){
  if(!fs.existsSync(file)){console.log('skip',file);continue;}
  let text=fs.readFileSync(file,'utf8');
  const before=text;
  for(const [from,to] of swaps) text=text.split(from).join(to);
  if(text!==before){fs.writeFileSync(file,text,'utf8');console.log('updated',file);}
  else console.log('unchanged',file);
}
