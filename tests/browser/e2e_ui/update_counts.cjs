const fs=require('fs');
const file='tests/browser/workshop_pipeline_readonly.py';
let text=fs.readFileSync(file,'utf8');
// The circles carry the stages plus the summary and the files entries.
text=text.replace("expect(page.get_by_role('region', name='Fases del trabajo').locator('li')).to_have_count(6)",
  "expect(page.get_by_role('region', name='Fases del trabajo').locator('li')).to_have_count(8)");
text=text.replace("expect(page.get_by_role('region', name='Fases del trabajo').locator('li')).to_have_count(3)",
  "expect(page.get_by_role('region', name='Fases del trabajo').locator('li')).to_have_count(5)");
fs.writeFileSync(file,text,'utf8');
console.log('updated',file);
