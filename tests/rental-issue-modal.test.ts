import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Module from 'node:module';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {reviewRentalPeriod,type PeriodInput} from '../src/controladores/rental-lifecycle';
import {rentalIssueAttempt,rentalIssueBody,rentalIssueConsequence,rentalIssueDays,rentalIssueFacts,
  rentalIssuePeriod,rentalIssuePrefill,rentalIssueReasonHint,rentalIssueSubmitLabel,rentalIssueTitle,
  type RentalIssueFacts,type RentalIssuePrefill} from '../src/controladores/rental-issue-modal';
import type {Reservation} from '../src/lib/supabase/reservations';

// The components of the app import CSS modules; the node runner only needs the markup.
const extensions=(Module as unknown as {_extensions:Record<string,unknown>})._extensions;
extensions['.css']=(module:{exports:unknown})=>{module.exports=new Proxy({},{get:()=>undefined});};
const {RentalIssueForm}=require('../src/components/organisms/rental-periods') as
  {RentalIssueForm:(props:{facts:RentalIssueFacts;prefill:RentalIssuePrefill;busy:boolean;error:string;
    onIssue:(input:PeriodInput)=>void})=>React.ReactElement};

const booking={id:'rental-1',version:7,status:'Confirmada',rental_state:'Cerrado',
  starts_at:'2026-11-01T12:00:00-06:00',ends_at:'2026-11-08T12:00:00-06:00',
  daily_rate:50,total:350,customer_snapshot:{name:'Ana Rivas'},vehicle_snapshot:{plate:'P-123',brand:'Toyota',model:'Yaris'}} as unknown as Reservation;

const facts=RentalIssueFactsOf();
function RentalIssueFactsOf():RentalIssueFacts{
  const period=rentalIssuePeriod(booking,[]);
  return rentalIssueFacts(booking,{plate:'P-123',brand:'Toyota',model:'Yaris'},period,
    {agreed:350,pending:310,pendingToEmit:230},50);
}
const prefill=rentalIssuePrefill(rentalIssuePeriod(booking,[]),'2026-11-22',350,230);

// A rental delivered and returned on the same calendar day occupies exactly one day: the period must
// not end before it starts, otherwise the form is impossible to submit for any amount.
test('a same-day rental produces a one-day period the server accepts',()=>{
  const sameDay={...booking,starts_at:'2026-11-23T08:00:00-06:00',ends_at:'2026-11-23T23:30:00-06:00'} as unknown as Reservation;
  const period=rentalIssuePeriod(sameDay,[]);
  assert.equal(period.startsOn,'2026-11-23');
  assert.equal(period.endsOn,'2026-11-23');
  assert.equal(period.days,1);
  const input={startsOn:period.startsOn,endsOn:period.endsOn,date:'2026-11-23',dueOn:'2026-12-07',
    amount:'50',reason:'Alquiler de un día'};
  assert.doesNotThrow(()=>reviewRentalPeriod(sameDay,input,[]));
});

test('an evening return is not shifted to the previous day',()=>{
  // 23:30 local is already the next day in UTC; the local day must win.
  const evening={...booking,starts_at:'2026-11-23T08:00:00-06:00',ends_at:'2026-11-24T05:30:00Z'} as unknown as Reservation;
  const period=rentalIssuePeriod(evening,[]);
  assert.equal(period.endsOn,'2026-11-23');
  assert.ok(period.startsOn<=period.endsOn!);
});

test('the folio period form derives the contractual end from the local return day',()=>{
  const source=readFileSync('src/components/organisms/rental-periods.tsx','utf8');
  // The local return day feeds the shared clamp, so a same-day rental cannot invert the range.
  assert.match(source,/const contractualEnd=booking\.open_ended\?'':rentalIssueEnd\(contractualStart,localDate\(booking\.ends_at\)\)/);
});

function render(props:{facts?:RentalIssueFacts;prefill?:RentalIssuePrefill;busy?:boolean;error?:string}={}){
  return renderToStaticMarkup(h(RentalIssueForm,{facts:props.facts??facts,prefill:props.prefill??prefill,
    busy:props.busy??false,error:props.error??'',onIssue:()=>{}}));
}

test('the issuing modal shows the agreed facts as read-only context, never as questions',()=>{
  const markup=render();
  // The customer, the vehicle, the period, the days and the agreed total are already known.
  assert.match(markup,/Ana Rivas/);
  assert.match(markup,/P-123 · Toyota Yaris/);
  assert.match(markup,/2026-11-01 al 2026-11-07/);
  assert.match(markup,/Días del período<\/dt><dd>7<\/dd>/);
  assert.match(markup,/Total acordado<\/dt><dd>\$350\.00<\/dd>/);
  assert.match(markup,/Pendiente por cobrar<\/dt><dd>\$310\.00<\/dd>/);
  assert.match(markup,/Pendiente de emitir<\/dt><dd>\$230\.00<\/dd>/);
  // None of them is an input: the operator never retypes what the system already knows.
  const inputs=[...markup.matchAll(/<input[^>]*>/g)].map(match=>match[0]);
  assert.equal(inputs.length,5);
  assert.ok(!inputs.some(input=>/Ana Rivas|P-123/.test(input)));
});

test('only the amount, the emission date, the due date and the reason are editable',()=>{
  const markup=render();
  assert.match(markup,/<input type="number" min="0\.01" step="0\.01" required="" name="amount" value="230\.00"\/>/);
  assert.match(markup,/<input type="date" required="" name="date" value="2026-11-22"\/>/);
  assert.match(markup,/<input type="date" required="" name="dueOn" value="2026-12-07"\/>/);
  assert.match(markup,/<textarea name="reason" required=""><\/textarea>/);
  // The period dates are prefilled from the agreement and live in a collapsed disclosure.
  assert.match(markup,/<summary>Modificar las fechas del período<\/summary>/);
  assert.doesNotMatch(markup,/<details[^>]*open/);
  assert.match(markup,/<input type="date" required="" name="startsOn" value="2026-11-01"\/>/);
  assert.match(markup,/<input type="date" required="" name="endsOn" value="2026-11-07"\/>/);
});

test('the amount starts with the agreed amount of the period and the agreed total stays as reference',()=>{
  const markup=render();
  assert.match(markup,/Total acordado de referencia: \$350\.00\./);
  assert.match(markup,/Queda por emitir \$230\.00\./);
  // The final action names the amount it is about to issue.
  assert.match(markup,/Emitir importe a cobrar de \$230\.00/);
  assert.equal(rentalIssueSubmitLabel('50'),'Emitir importe a cobrar de $50.00');
});

test('the modal states the consequence in plain words and never speaks of a cargo',()=>{
  assert.equal(rentalIssueTitle,'Emitir importe a cobrar');
  assert.equal(rentalIssueConsequence,'Registra el documento de cobro de este período. No recibe dinero ni cancela la deuda pendiente.');
  assert.match(rentalIssueReasonHint,/acuerdo del período/);
  const source=readFileSync('src/components/organisms/rental-periods.tsx','utf8');
  const modal=source.slice(source.indexOf('export function RentalIssueModal'));
  assert.doesNotMatch(modal,/cargo/i);
  assert.doesNotMatch(render(),/cargo/i);
});

test('the submission is the canonical period payload with the version of the folio',()=>{
  const input:PeriodInput={startsOn:'2026-11-01',endsOn:'2026-11-07',date:'2026-11-22',dueOn:'2026-12-07',
    amount:'230.00',reason:'Se emite el total acordado del período'};
  const payload=reviewRentalPeriod(booking,input,[]).payload;
  assert.equal(payload.reservationId,booking.id);
  assert.equal(payload.expectedVersion,booking.version);
  assert.equal(payload.startsOn,'2026-11-01');
  assert.equal(payload.endsOn,'2026-11-07');
  assert.equal(payload.amount,'230.00');
  assert.equal(payload.reason,'Se emite el total acordado del período');
  // The command body is the canonical one: the same command, the same payload.
  assert.equal(rentalIssueBody('period',payload),JSON.stringify({command:'period',payload}));
});

test('a failed submission keeps the typed values and the retry travels with the same key',()=>{
  const markup=render({error:'No se guardó la operación. Revise los datos y la conexión.'});
  assert.match(markup,/role="alert"[^>]*>No se guardó la operación\./);
  // The typed values survive the failure: the form is never reset.
  assert.match(markup,/name="amount" value="230\.00"/);
  assert.match(markup,/name="reason" required=""><\/textarea>/);
  const payload=reviewRentalPeriod(booking,{startsOn:'2026-11-01',endsOn:'2026-11-07',date:'2026-11-22',
    dueOn:'2026-12-07',amount:'230.00',reason:'Se emite el total acordado del período'},[]).payload;
  const body=rentalIssueBody('period',payload);
  let counter=0;
  const makeKey=()=>`key-${++counter}`;
  const first=rentalIssueAttempt(null,body,makeKey);
  const failed=rentalIssueAttempt(first,body,makeKey);
  assert.equal(failed.key,first.key,'a retry with the same values must reuse the idempotency key');
  assert.equal(counter,1);
  const changed=rentalIssueAttempt(failed,rentalIssueBody('period',{...payload,amount:'200.00'}),makeKey);
  assert.notEqual(changed.key,first.key,'a different request is a different key');
});

test('the period of the modal is the agreed one and its days are the inclusive ones',()=>{
  const period=rentalIssuePeriod(booking,[]);
  assert.equal(period.startsOn,'2026-11-01');
  assert.equal(period.endsOn,'2026-11-07');
  assert.equal(period.days,7);
  assert.equal(period.contractualStart,'2026-11-01');
  assert.equal(period.contractualEnd,'2026-11-07');
  assert.equal(rentalIssueDays('2026-11-01','2026-11-07'),7);
  assert.equal(rentalIssueDays('2026-11-07','2026-11-01'),null);
  // After a documented period the next one continues the day after the last one.
  const next=rentalIssuePeriod(booking,[{starts_on:'2026-11-01',ends_on:'2026-11-03'}]);
  assert.equal(next.startsOn,'2026-11-04');
  assert.equal(next.endsOn,'2026-11-07');
  assert.equal(next.days,4);
});
