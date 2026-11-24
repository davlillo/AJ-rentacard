const fs=require('fs');

const lifecycle='tests/browser/rental_lifecycle_readonly.py';
let text=fs.readFileSync(lifecycle,'utf8');
text=text.replace("to_contain_text('NO es un cargo')","to_contain_text('NO es un importe a cobrar ni un pago recibido')");
fs.writeFileSync(lifecycle,text,'utf8');
console.log('updated',lifecycle);
