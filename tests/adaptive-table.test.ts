import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AdaptiveTable} from '../src/components/organisms/adaptive-table';

test('Adaptive records retain table semantics and all values with mobile field labels',()=>{
  const output=renderToStaticMarkup(h(AdaptiveTable,null,
    h('thead',null,h('tr',null,h('th',null,'Client'),h('th',null,'Amount'),h('th'))),
    h('tbody',null,[h('tr',{key:1},h('td',null,'Rafael Vargas'),h('td',null,'$2,190.00'),h('td',null,h('button',null,'Open')))])));
  assert.match(output,/role="table"/);assert.match(output,/data-label="Client" role="cell">Rafael Vargas/);
  assert.match(output,/data-label="Amount" role="cell">\$2,190.00/);assert.match(output,/<button>Open<\/button>/);
  assert.equal((output.match(/role="cell"/g)??[]).length,3);
});
