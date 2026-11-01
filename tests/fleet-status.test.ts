import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fleetStatus} from '../src/controladores/fleet-status';
import type {ReservationHistory,Vehicle} from '../src/types';

const car:Vehicle={id:'car',plate:'P123',brand:'Nissan',model:'Versa',year:2020,category:'Sedán',color:'White',
  daily:35,km:100,status:'Disponible',inRentalFleet:true};
const now=Date.parse('2026-10-30T12:00:00Z');
const booking:ReservationHistory={id:'booking',vehicleId:'car',customerId:'customer',start:'2026-11-01T12:00:00Z',
  end:'2026-11-03T12:00:00Z',status:'Confirmada',rentalState:'Preparado'};

test('Fleet filters: only a confirmed upcoming/prepared reservation marks an available car reserved',()=>{
  assert.equal(fleetStatus(car,[],now),'Disponible');
  assert.equal(fleetStatus(car,[booking],now),'Reservado');
  assert.equal(fleetStatus(car,[{...booking,end:'infinity'}],now),'Reservado');
  for(const ignored of [{...booking,status:'Borrador'},{...booking,status:'Cancelada'},
    {...booking,rentalState:'Devuelto'},{...booking,end:'2026-10-29T12:00:00Z'},
    {...booking,vehicleId:'other'}])assert.equal(fleetStatus(car,[ignored],now),'Disponible');
});

test('Fleet filters preserve physical rental/workshop states even if another reservation is pending',()=>{
  assert.equal(fleetStatus({...car,status:'Alquilado'},[booking],now),'Alquilado');
  assert.equal(fleetStatus({...car,status:'En taller'},[booking],now),'En taller');
});
