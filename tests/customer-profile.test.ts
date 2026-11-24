import {test} from 'node:test';
import assert from 'node:assert/strict';
import {customerDocumentsAt,customerHref,customerMissingFields,customerOperations,customerVehicles} from '../src/controladores/customer-profile';
import type {BusinessData,Customer,ReservationHistory,Vehicle,WorkOrder} from '../src/types';
import type {Receivable} from '../src/lib/supabase/billing';

const customer:Customer={id:'customer',name:'Test Customer',phone:'',document:'',email:'',type:'Personal'};
const order=(id:string,status:WorkOrder['status']='Diagnóstico'):WorkOrder=>({id,status,vehicleId:'car',customerId:'customer',
  area:'Mecánica',service:'Test service',technician:'',hours:0,estimate:999,paid:0,due:'2026-11-12'});
const rental=(id:string,rentalState:string,status='Confirmada'):ReservationHistory=>({id,rentalState,status,
  customerId:'customer',vehicleId:'rental-car',start:'2026-11-01T12:00:00Z',end:'infinity',folioNumber:12});
const data:BusinessData={customers:[customer],vehicles:[],orders:[],reservationHistory:[],rentals:[],movements:[],items:[],estimates:[]};

test('Customer profile links encode identifiers and preserve shareable section names',()=>{
  const url=new URL(customerHref('id&other=secret','Datos y documentos'),'https://local.test');
  assert.equal(url.pathname,'/clientes/expediente/');assert.equal(url.searchParams.get('id'),'id&other=secret');
  assert.equal(url.searchParams.get('seccion'),'Datos y documentos');assert.equal(url.searchParams.has('other'),false);
  assert.equal(new URL(customerHref('client'),'https://local.test').searchParams.has('seccion'),false);
});

test('Customer pipeline uses real exclusive physical stages, not budget values, billing or another client',()=>{
  const operations=customerOperations({...data,orders:[order('OT-1','Presupuesto'),order('OT-2'),
    order('OT-3','Entregado'),{...order('unrelated'),customerId:'another'}],
  reservationHistory:[rental('prepared','Preparado'),rental('out','Entregado'),rental('returned','Devuelto'),
    rental('closed','Cerrado'),rental('draft','Preparado','Borrador'),rental('cancelled','Entregado','Cancelada'),
    rental('unknown','Unsupported'),{...rental('foreign','Entregado'),customerId:'another'}]},'customer');
  const find=(id:string)=>operations.find(operation=>operation.id===id)!;
  assert.equal(operations.length,10);assert.equal(find('OT-1').active,false);assert.equal(find('OT-1').stage,'Presupuesto');
  assert.equal(find('OT-2').active,true);assert.equal(find('OT-3').active,false);
  assert.equal(find('prepared').stage,'Reservado');assert.equal(find('prepared').active,false);
  assert.equal(find('out').stage,'En alquiler');assert.equal(find('out').active,true);
  assert.equal(find('returned').stage,'Devuelto');assert.equal(find('returned').active,false);
  assert.equal(find('closed').stage,'Cerrado');assert.equal(find('draft').stage,'Borrador');
  assert.equal(find('cancelled').stage,'Cancelado');assert.equal(find('cancelled').active,false);
  assert.equal(find('unknown').stage,'Por revisar');
});

test('Customer vehicles include ownership and operational relationships once, never unrelated cars',()=>{
  const car=(id:string,ownerCustomerId:string|null=null):Vehicle=>({id,ownerCustomerId,plate:id,brand:'Test',model:'Unit',
    year:2020,color:'Blue',category:'Sedán',daily:30,km:0,status:'Disponible'});
  const operations=customerOperations({...data,orders:[order('OT-1'),order('OT-2')],reservationHistory:[rental('r','Preparado')]},'customer');
  assert.deepEqual(customerVehicles([car('car'),car('rental-car'),car('owned','customer'),car('another')],operations,'customer')
    .map(car=>car.id),['car','rental-car','owned']);
});

test('Customer financial profile follows canonical ownership after merges, not stale original snapshots',()=>{
  const document=(id:string,customerId:string,currentId:string):Receivable=>({id,customer_id:customerId,current_customer_id:currentId,
    customer_snapshot:customer,reservation_id:null,order_id:null,description:'Test',amount:100,balance:50,
    due_on:'2026-11-12',days_overdue:0,aging_bucket:'Por vencer'});
  assert.deepEqual(customerDocumentsAt([document('merged','old-id','customer'),document('own','customer','customer'),
    document('moved','customer','other'),document('same-name','other','other')],'customer').map(doc=>doc.id),['merged','own']);
});

test('Customer missing data stays explicit instead of being filled with fabricated values',()=>{
  assert.deepEqual(customerMissingFields(customer),['Teléfono','Documento','Correo electrónico']);
  assert.deepEqual(customerMissingFields({...customer,phone:'12345678',document:'DOC',email:'test@example.test'}),[]);
});
