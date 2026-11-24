const fs=require('fs');
const file='tests/browser/rental_accounts_readonly.py';
let text=fs.readFileSync(file,'utf8');
text=text.replace(
  "            page.get_by_role('button', name='Cobrar saldo pendiente', exact=True).click()",
  "            # The collection is opened once, from the header of the folio.\n            page.get_by_role('button', name='Realizar cobro', exact=True).click()");
fs.writeFileSync(file,text,'utf8');
console.log('updated',file);
