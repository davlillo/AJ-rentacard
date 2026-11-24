import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedScopeTotal,workshopCollectionState} from '../src/controladores/workshop-money-language';

const file={
  orders:[{id:'OT-37',active_estimate_id:'quote-1'},{id:'OT-40',active_estimate_id:null}],
  quotes:[
    {id:'quote-1',order_id:'OT-37',status:'Aprobado',snapshot:{total:150}},
    {id:'quote-2',order_id:'OT-37',status:'Borrador',snapshot:{total:180}},
    {id:'quote-3',order_id:'OT-40',status:'Borrador',snapshot:{total:90}},
  ],
};

test('The agreed amount of a workshop job is its approved scope, never a draft revision',()=>{
  assert.equal(approvedScopeTotal(file,'OT-37'),150);
  assert.equal(approvedScopeTotal(file,'OT-40'),null);
  assert.equal(approvedScopeTotal({quotes:[],orders:[]},'OT-37'),null);
});

test('The agreed amount ignores an approved revision that belongs to another job',()=>{
  const other={orders:[{id:'OT-9',active_estimate_id:null}],
    quotes:[{id:'q9',order_id:'OT-9',status:'Aprobado',snapshot:{total:500}}]};
  assert.equal(approvedScopeTotal(other,'OT-9'),500);
  assert.equal(approvedScopeTotal({...other,orders:[{id:'OT-9',active_estimate_id:null}]},
    'OT-404'),null);
});

test('The collection state is spoken in the words of the operator',()=>{
  assert.equal(workshopCollectionState('Sin cargo'),'Sin importe emitido');
});
