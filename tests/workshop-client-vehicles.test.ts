import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workshopClientVehicles} from '../src/controladores/workshop-client-vehicles';

const vehicles=[
  {id:'client-a',inRentalFleet:false},
  {id:'client-b',inRentalFleet:false},
  {id:'fleet',inRentalFleet:true},
];

test('Workshop client vehicles exclude preserved registry entries when no jobs exist',()=>{
  assert.deepEqual(workshopClientVehicles(vehicles,[]),[]);
});

test('Workshop client vehicles include open client jobs once and exclude delivered jobs and rental fleet',()=>{
  const orders=[
    {vehicleId:'client-a',status:'En taller'},
    {vehicleId:'client-a',status:'Presupuesto'},
    {vehicleId:'client-b',status:'Entregado'},
    {vehicleId:'fleet',status:'En taller'},
  ];
  assert.deepEqual(workshopClientVehicles(vehicles,orders),[vehicles[0]]);
});
