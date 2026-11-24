const fs=require('fs');
const file='tests/browser/rental_accounts_readonly.py';
let text=fs.readFileSync(file,'utf8');
text=text.replace(
  "            expect(page.get_by_role('button', name='Cobrar saldo pendiente', exact=True)).to_have_count(1)",
  "            expect(page.get_by_role('button', name='Realizar cobro', exact=True)).to_have_count(1)");
fs.writeFileSync(file,text,'utf8');
console.log('updated',file);
