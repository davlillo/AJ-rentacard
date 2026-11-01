import type { BusinessData } from '@/types';
export const DEMO_TODAY = '2026-10-20';
export const seed:BusinessData={
vehicles:[
{id:'v1',plate:'P 284-109',brand:'Toyota',model:'Corolla',year:2023,category:'Sedán',color:'Plata',daily:45,km:28450,status:'Alquilado'},
{id:'v2',plate:'P 593-721',brand:'Hyundai',model:'Tucson',year:2024,category:'SUV',color:'Blanco',daily:75,km:18320,status:'Disponible'},
{id:'v3',plate:'P 821-456',brand:'Kia',model:'Picanto',year:2023,category:'Compacto',color:'Rojo',daily:35,km:32100,status:'Disponible'},
{id:'v4',plate:'P 170-382',brand:'Toyota',model:'Hilux',year:2022,category:'Pickup',color:'Gris',daily:90,km:45600,status:'Alquilado'},
{id:'v5',plate:'P 638-205',brand:'Nissan',model:'Versa',year:2023,category:'Sedán',color:'Azul',daily:40,km:24800,status:'En taller'},
{id:'v6',plate:'P 904-673',brand:'Hyundai',model:'Creta',year:2024,category:'SUV',color:'Blanco',daily:65,km:15200,status:'Alquilado'},
{id:'v7',plate:'P 415-892',brand:'Kia',model:'Sportage',year:2022,category:'SUV',color:'Negro',daily:70,km:41900,status:'En taller'},
{id:'v8',plate:'P 752-318',brand:'Suzuki',model:'Swift',year:2024,category:'Compacto',color:'Azul',daily:38,km:12800,status:'Disponible'}],
customers:[
{id:'c1',name:'Carlos Mendoza',email:'carlos@example.com',phone:'7890-1234',type:'Personal',document:'01234567-8'},
{id:'c2',name:'Ana Lucía Reyes',email:'ana@example.com',phone:'7234-5678',type:'Personal',document:'02345678-9'},
{id:'c3',name:'Constructora del Pacífico',email:'compras@example.com',phone:'2250-8100',type:'Empresa',document:'0614-000000-001-0'},
{id:'c4',name:'Roberto Hernández',email:'roberto@example.com',phone:'7112-8890',type:'Personal',document:'03456789-0'},
{id:'c5',name:'María José Castro',email:'maria@example.com',phone:'7654-3210',type:'Personal',document:'04567890-1'},
{id:'c6',name:'Distribuidora Central',email:'logistica@example.com',phone:'2200-9800',type:'Empresa',document:'0614-000000-002-0'}],
rentals:[
{id:'AL-1042',vehicleId:'v1',customerId:'c1',start:'2026-10-19T08:00',end:'2026-10-22T08:00',total:135,paid:135,status:'En curso'},
{id:'AL-1043',vehicleId:'v4',customerId:'c3',start:'2026-10-18T09:00',end:'2026-10-23T09:00',total:450,paid:200,status:'En curso'},
{id:'AL-1044',vehicleId:'v6',customerId:'c2',start:'2026-10-19T14:00',end:'2026-10-21T14:00',total:130,paid:65,status:'En curso'},
{id:'AL-1045',vehicleId:'v2',customerId:'c4',start:'2026-10-21T08:00',end:'2026-10-24T08:00',total:225,paid:75,status:'Confirmada'},
{id:'AL-1046',vehicleId:'v3',customerId:'c5',start:'2026-10-23T10:00',end:'2026-10-25T10:00',total:70,paid:0,status:'Confirmada'},
{id:'AL-1039',vehicleId:'v8',customerId:'c6',start:'2026-10-14T08:00',end:'2026-10-17T08:00',total:114,paid:50,status:'Finalizada'},
{id:'AL-1038',vehicleId:'v2',customerId:'c1',start:'2026-10-12T09:00',end:'2026-10-15T09:00',total:225,paid:225,status:'Finalizada'}],
orders:[
{id:'OT-0284',vehicleId:'v5',customerId:'c4',area:'Mecánica',service:'Mantenimiento de frenos',technician:'Luis Ramírez',status:'En proceso',hours:2.5,estimate:185,paid:80,due:'2026-10-21'},
{id:'OT-0285',vehicleId:'v7',customerId:'c5',area:'Pintura',service:'Reparación de guardafango',technician:'Miguel Torres',status:'Diagnóstico',hours:1,estimate:320,paid:0,due:'2026-10-23'},
{id:'OT-0281',vehicleId:'v1',customerId:'c1',area:'Mecánica',service:'Cambio de aceite y filtros',technician:'Luis Ramírez',status:'Entregado',hours:1.5,estimate:90,paid:90,due:'2026-10-17'},
{id:'OT-0282',vehicleId:'v3',customerId:'c2',area:'Pintura',service:'Pulido de carrocería',technician:'Miguel Torres',status:'Entregado',hours:4,estimate:150,paid:150,due:'2026-10-16'}],
movements:[
{id:'MD-001',date:'2026-10-12',concept:'Alquiler Hyundai Tucson',amount:225,type:'Ingreso',area:'Renta',method:'Tarjeta',operation:'AL-1038'},
{id:'MD-002',date:'2026-10-14',concept:'Abono alquiler Suzuki Swift',amount:50,type:'Ingreso',area:'Renta',method:'Transferencia',operation:'AL-1039'},
{id:'MD-003',date:'2026-10-15',concept:'Materiales de pulido',amount:32,type:'Egreso',area:'Taller',method:'Efectivo',operation:'OT-0282'},
{id:'MD-004',date:'2026-10-16',concept:'Servicio de pulido',amount:150,type:'Ingreso',area:'Taller',method:'Tarjeta',operation:'OT-0282'},
{id:'MD-005',date:'2026-10-16',concept:'Aceite y filtro de motor',amount:37,type:'Egreso',area:'Taller',method:'Efectivo',operation:'OT-0281'},
{id:'MD-006',date:'2026-10-17',concept:'Servicio de mantenimiento',amount:90,type:'Ingreso',area:'Taller',method:'Efectivo',operation:'OT-0281'},
{id:'MD-007',date:'2026-10-18',concept:'Anticipo alquiler Toyota Hilux',amount:200,type:'Ingreso',area:'Renta',method:'Transferencia',operation:'AL-1043'},
{id:'MD-008',date:'2026-10-19',concept:'Alquiler Toyota Corolla',amount:135,type:'Ingreso',area:'Renta',method:'Tarjeta',operation:'AL-1042'},
{id:'MD-009',date:'2026-10-19',concept:'Abono alquiler Hyundai Creta',amount:65,type:'Ingreso',area:'Renta',method:'Efectivo',operation:'AL-1044'},
{id:'MD-010',date:'2026-10-19',concept:'Pastillas de freno delanteras',amount:42,type:'Egreso',area:'Taller',method:'Transferencia',operation:'OT-0284'},
{id:'MD-011',date:'2026-10-20',concept:'Reserva Hyundai Tucson',amount:75,type:'Ingreso',area:'Renta',method:'Transferencia',operation:'AL-1045'},
{id:'MD-012',date:'2026-10-20',concept:'Anticipo mantenimiento de frenos',amount:80,type:'Ingreso',area:'Taller',method:'Efectivo',operation:'OT-0284'},
{id:'MD-013',date:'2026-10-20',concept:'Líquido de frenos DOT 4',amount:12,type:'Egreso',area:'Taller',method:'Efectivo',operation:'OT-0284'},
{id:'MD-014',date:'2026-10-20',concept:'Lija y materiales de preparación',amount:28,type:'Egreso',area:'Taller',method:'Efectivo',operation:'OT-0285'},
{id:'MD-015',date:'2026-10-20',concept:'Servicios de oficina',amount:45,type:'Egreso',area:'Administración',method:'Transferencia',operation:'Administración'}],
items:[{id:'i1',name:'Aceite de motor 5W-30',sku:'LUB-001',category:'Lubricantes',stock:12,min:5,cost:8.5},{id:'i2',name:'Pastillas de freno delanteras',sku:'FRE-014',category:'Repuestos',stock:3,min:4,cost:42},{id:'i3',name:'Filtro de aceite Toyota',sku:'FIL-008',category:'Filtros',stock:8,min:3,cost:11.5},{id:'i4',name:'Líquido de frenos DOT 4',sku:'LUB-007',category:'Lubricantes',stock:2,min:3,cost:12},{id:'i5',name:'Pintura automotriz blanca',sku:'PIN-003',category:'Pintura',stock:6,min:2,cost:24},{id:'i6',name:'Lija al agua 1200',sku:'MAT-021',category:'Materiales',stock:24,min:10,cost:1.25}],
estimates:[{id:'PR-0185',orderId:'OT-0284',customerId:'c4',lines:[{description:'Pastillas de freno delanteras',quantity:1,cost:42,price:65},{description:'Líquido de frenos',quantity:1,cost:12,price:20},{description:'Mano de obra · 2.5 horas',quantity:1,cost:40,price:100}],discount:0,status:'Aprobado'},{id:'PR-0186',orderId:'OT-0285',customerId:'c5',lines:[{description:'Materiales de preparación y pintura',quantity:1,cost:95,price:140},{description:'Enderezado y pintura · mano de obra',quantity:1,cost:85,price:180}],discount:0,status:'Enviado'}]
};
