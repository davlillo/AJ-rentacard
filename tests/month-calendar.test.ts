import {test} from 'node:test';
import assert from 'node:assert/strict';
import {monthDays,shiftMonth,intersectsDay,calendarDate} from '../src/controladores/month-calendar';

test('Monthly calendar has six complete Monday-first weeks and crosses years without local timezone drift',()=>{
  const days=monthDays('2026-11');assert.equal(days.length,42);assert.equal(days[0],'2026-10-26');assert.equal(days[41],'2026-12-06');
  assert.equal(shiftMonth('2026-12',1),'2027-01');assert.equal(shiftMonth('2026-01',-1),'2025-12');
  assert.equal(monthDays('2028-02').filter(day=>day.startsWith('2028-02')).length,29);
});
test('Reservation highlighting uses Salvador dates and exclusive end boundaries, including open-ended rentals',()=>{
  assert.equal(calendarDate('2026-11-02T02:00:00Z'),'2026-11-01');
  assert.equal(intersectsDay('2026-11-01','2026-11-02T02:00:00Z','2026-11-04T06:00:00Z'),true);
  assert.equal(intersectsDay('2026-11-03','2026-11-02T02:00:00Z','2026-11-04T06:00:00Z'),true);
  assert.equal(intersectsDay('2026-11-04','2026-11-02T02:00:00Z','2026-11-04T06:00:00Z'),false);
  assert.equal(intersectsDay('2027-01-01','2026-11-02T02:00:00Z','infinity'),true);
});
