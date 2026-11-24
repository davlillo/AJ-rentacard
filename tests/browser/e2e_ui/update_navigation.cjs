const fs=require('fs');

// The workshop folio navigates with the stage circles now: the sections bar is gone.
const workshopPipeline='tests/browser/workshop_pipeline_readonly.py';
let pipeline=fs.readFileSync(workshopPipeline,'utf8');
pipeline=pipeline.replace(
  "def tab(page, name):\n    return page.get_by_role('navigation', name='Secciones del expediente').get_by_role('button', name=name, exact=True)",
  "def tab(page, name):\n    # The circles are the only navigation of the workshop folio.\n    return page.get_by_role('region', name='Fases del trabajo').get_by_role('button', name=name)");
pipeline=pipeline.split("('Salida', 'Entrega'), ('Recepción', 'Diagnóstico')]").join("('Salida', 'Entrega'), ('Recepción', 'Ingreso y diagnóstico')]");
fs.writeFileSync(workshopPipeline,pipeline,'utf8');
console.log('updated',workshopPipeline);

const dossier='tests/browser/vehicle_dossier_readonly.py';
let text=fs.readFileSync(dossier,'utf8');
text=text.replace(
  "            order_sections = page.get_by_role('navigation', name='Secciones del expediente')\n            expect(order_sections.get_by_role('button')).to_have_count(5)\n            for label in ['Resumen', 'Diagnóstico', 'Trabajo y costos reales', 'Entrega', 'Fotos y documentos']:\n                expect(order_sections.get_by_role('button', name=label, exact=True)).to_be_visible()\n            expect(order_sections.get_by_role('button', name='Cobros', exact=True)).to_have_count(0)",
  "            order_sections = page.get_by_role('region', name='Fases del trabajo')\n            expect(order_sections.get_by_role('button')).to_have_count(5)\n            for label in ['Resumen', 'Ingreso y diagnóstico', 'Trabajo y costos reales', 'Entrega', 'Fotos y documentos']:\n                expect(order_sections.get_by_role('button', name=label)).to_be_visible()\n            expect(order_sections.get_by_role('button', name='Cobros')).to_have_count(0)");
fs.writeFileSync(dossier,text,'utf8');
console.log('updated',dossier);

const polish='tests/browser/targeted_polish_readonly.py';
let polishText=fs.readFileSync(polish,'utf8');
polishText=polishText.replace(
  "page.get_by_role('navigation', name='Secciones del expediente').get_by_role('button', name='Diagnóstico', exact=True).click()",
  "page.get_by_role('region', name='Fases del trabajo').get_by_role('button', name='Ingreso y diagnóstico').click()");
fs.writeFileSync(polish,polishText,'utf8');
console.log('updated',polish);
