import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seed} from '../src/datos/demo';
import {customerMatches, searchCustomers} from '../src/controladores/clientes';

test('HU01: phone and document matches ignore formatting', () => {
  assert.equal(customerMatches(seed.customers, '(7890) 1234', '').at(0)?.id, 'c1');
  assert.equal(customerMatches(seed.customers, '', '012345678').at(0)?.id, 'c1');
  assert.equal(customerMatches(seed.customers, '', '').length, 0);
});

test('HU01: directory searches formatted phones and partial documents', () => {
  assert.equal(searchCustomers(seed.customers, '7890 12').at(0)?.id, 'c1');
  assert.equal(searchCustomers(seed.customers, '01234567').at(0)?.id, 'c1');
  assert.equal(searchCustomers(seed.customers, 'CARLOS').at(0)?.id, 'c1');
  assert.equal(searchCustomers(seed.customers, ' ').length, seed.customers.length);
});

test('HU01: merged contacts remain searchable without duplicating the survivor', () => {
  const customers = [{...seed.customers[0], aliases: [{name: 'Previous name', phone: '7000-0000', document: 'OLD-123'}]}];
  assert.equal(customerMatches(customers, '70000000', 'OLD123').length, 1);
  assert.equal(searchCustomers(customers, 'Previous').length, 1);
  assert.equal(searchCustomers(customers, '7000 0000').length, 1);
  assert.equal(searchCustomers(customers, 'OLD123').length, 1);
});
