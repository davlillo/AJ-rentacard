import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {customerSection,customerSections} from '../src/controladores/customer-profile';
import {rentalSection,rentalSectionStage,rentalSections} from '../src/controladores/rental-workflow';

const source=(path:string)=>readFileSync(path,'utf8');
const occurrences=(text:string,needle:string):number=>text.split(needle).length-1;

// Every operator-facing surface that used to say "Cargos y cobros" as a destination.
const operatorSurfaces=[
  'src/components/templates/operational-shell.tsx',
  'src/components/templates/operational-billing.tsx',
  'src/components/molecules/page-heading.tsx',
  'src/components/organisms/linked-receipt.tsx',
  'src/components/organisms/rental-periods.tsx',
  'src/components/organisms/rental-accounts.tsx',
  'src/components/organisms/rental-operation.tsx',
  'src/components/templates/source-workbooks-screen.tsx',
  'src/components/templates/clientes-screen.tsx',
  'src/components/templates/connected-ledger.tsx',
  'src/components/templates/vehicle-dossier.tsx',
  'src/components/templates/operational-calendar.tsx',
  'src/components/templates/customer-profile-screen.tsx',
];

test('the operator navigation names the billing destination in plain language',()=>{
  const shell=source('src/components/templates/operational-shell.tsx');
  assert.ok(shell.includes("{href:'/cobros',label:'Cobros'"),'the /cobros entry is labelled Cobros');
  assert.ok(!shell.includes('Cargos y cobros'));
  // The route, the permission and the icon are untouched.
  assert.ok(shell.includes("{href:'/cobros',label:'Cobros',icon:Wallet,permission:'expenses.read'}"));
});

test('the /cobros page states what was issued, collected and pending',()=>{
  const billing=source('src/components/templates/operational-billing.tsx');
  assert.ok(billing.includes('<PageHeading title="Cobros"'),'the page title is Cobros');
  assert.ok(billing.includes('lo que se emitió, lo que se cobró y lo que falta por cobrar'));
  assert.ok(billing.includes("toast('Cobros actualizados.')"));
  assert.ok(!billing.includes('Cargos y cobros'));
  // The module heading still suppresses the eyebrow of the module page.
  const heading=source('src/components/molecules/page-heading.tsx');
  assert.ok(heading.includes("'Presupuestos','Cobros','Libro diario'"));
  assert.ok(!heading.includes('Cargos y cobros'));
});

test('no operator-facing surface still offers the removed jargon as a destination',()=>{
  for(const path of operatorSurfaces){
    assert.equal(occurrences(source(path),'Cargos y cobros'),0,path);
  }
});

test('the shared links name the destination with the plain word',()=>{
  assert.ok(source('src/components/organisms/linked-receipt.tsx')
    .includes('Los documentos agrupados se gestionan en Cobros →'));
  assert.ok(source('src/components/organisms/rental-periods.tsx')
    .includes('Consultar o aplicar recibos en Cobros'));
  assert.ok(source('src/components/organisms/rental-accounts.tsx')
    .includes('en Cobros →'));
  assert.ok(source('src/components/organisms/rental-operation.tsx').includes('Ver cobros →'));
  assert.ok(source('src/components/templates/source-workbooks-screen.tsx')
    .includes('Su aplicación se revisa en Cobros.'));
  assert.ok(source('src/components/templates/operational-calendar.tsx').includes('>Ver cobros</Link>'));
  assert.ok(source('src/components/templates/vehicle-dossier.tsx')
    .includes('Los cobros y abonos no se suman como ingreso de caja.'));
  assert.ok(source('src/components/templates/clientes-screen.tsx')
    .includes("customerHref(customer.id,'Cobros')"));
  // The ledger points at the section that exists today, not at a retired alias.
  assert.ok(source('src/components/templates/connected-ledger.tsx')
    .includes("row.source_type==='receipt'?'Cuentas':'Costos'"));
});

test('the customer profile section is Cobros and the legacy URL still resolves',()=>{
  assert.ok(customerSections.includes('Cobros'));
  assert.ok(!customerSections.includes('Cargos y cobros' as never));
  assert.equal(customerSection('Cobros'),'Cobros');
  // The legacy ?seccion=Cargos+y+cobros keeps resolving to the renamed section.
  assert.equal(customerSection('Cargos y cobros'),'Cobros');
  assert.equal(customerSection('Operaciones'),'Operaciones');
  assert.equal(customerSection('Datos y documentos'),'Datos y documentos');
  assert.equal(customerSection(null),'Operaciones');
  assert.equal(customerSection('unknown'),'Operaciones');
  // The profile screen resolves the section through that mapping, and compares consistently.
  const profile=source('src/components/templates/customer-profile-screen.tsx');
  assert.ok(profile.includes("customerSection(search.get('seccion'))"));
  assert.ok(profile.includes("item!=='Cobros'"));
  assert.ok(profile.includes("section==='Cobros'"));
});

test('the rental folio legacy aliases keep resolving to their current section',()=>{
  assert.ok(rentalSections.includes('Cargos y abonos'));
  assert.equal(rentalSection('Cargos y abonos'),'Cargos y abonos');
  assert.equal(rentalSection('Períodos y abonos'),'Cargos y abonos');
  // The legacy sections resolve to the stage of the single flow that owns them now.
  assert.equal(rentalSectionStage('Cargos y abonos'),3);
  assert.equal(rentalSection('Limpieza'),'Limpieza');
  assert.equal(rentalSectionStage('Limpieza'),2);
});
