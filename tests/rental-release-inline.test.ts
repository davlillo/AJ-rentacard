import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Regression: the release of a returned vehicle is confirmed INLINE in the rental
// folio (Devolución and Cierre stages) with the canonical review_return_cleaning
// command. The folio no longer sends the operator to the vehicle dossier to
// release; the dossier keeps its secondary path. The command, payload, expected
// versions, idempotency key and permission stay exactly the canonical ones.

const source=(path:string)=>readFileSync(path,'utf8');

const folio=source('src/components/templates/rental-case-screen.tsx');
const release=source('src/components/organisms/vehicle-release-review.tsx');
const operation=source('src/components/organisms/rental-operation.tsx');

const stageTwo=folio.slice(folio.indexOf('{shown===2&&'),folio.indexOf('{shown===3&&'));
const stageFour=folio.slice(folio.indexOf('{shown===4&&'),folio.indexOf('{(error||loadError)'));

test('the Devolución stage confirms the release inline, without navigation',()=>{
  assert.ok(stageTwo.includes('<VehicleReleaseReview file={visibleFile} booking={booking} onChange={reload}/>'),
    'the release review is mounted inline in the return stage');
  assert.ok(!stageTwo.includes('vehicleHref'), 'the return stage no longer links to the dossier to release');
  assert.match(stageTwo,/Devuelto','Cerrado'/,'it mounts for a returned rental');
});

test('the Cierre stage confirms the release inline and keeps one primary',()=>{
  assert.ok(stageFour.includes("['Devuelto','Cerrado'].includes(booking.rental_state)&&<div className={styles.releaseAction}>"),
    'the release review stays mounted after the release so the confirmation notice persists');
  assert.ok(stageFour.includes('<VehicleReleaseReview file={visibleFile} booking={booking} onChange={reload}/>'));
  assert.ok(!stageFour.includes('Liberar el vehículo</Link>'),'no navigation link replaces the inline action');
  assert.ok(!stageFour.includes('expediente del vehículo'),'the closing note no longer sends the operator away');
  // The folio source itself still adds no primary <Button> of its own: the release
  // review owns the primary inside its component, and the contract stays in details.
  for(const match of stageFour.matchAll(/<Button\b/g)){
    const tag=stageFour.slice(match.index,stageFour.indexOf('>',match.index)+1);
    assert.match(tag,/variant="outline"/,'every button the closing stage renders directly stays secondary');
  }
});

test('the inline review keeps the canonical command, payload and guards',()=>{
  assert.match(release,/command:'review_return_cleaning'/,'the command is unchanged');
  assert.match(release,/reservationId:booking\.id,blockId:block\.id,expectedVersion:booking\.version,expectedVehicleVersion:file\.vehicle\.version/);
  assert.match(release,/reason:String\(f\.get\('reason'\)\)\.trim\(\)/,'the reason field stays required');
  assert.match(release,/can\('orders\.write'\)/,'the permission guard stays');
  assert.match(release,/rentalCleaningReviewable\(booking,block\)/,'the reviewable-commitment guard stays');
  assert.match(release,/execute\('reservation\.'\+intent\.command/,'the idempotency key comes from useCaseAction');
  assert.match(release,/El servidor confirmó la liberación del vehículo/,'the success feedback states the release');
  assert.match(release,/sigue retenido por otros compromisos/,'the retained-vehicle caveat stays');
});

test('the operation note points at the folio stages, not the dossier',()=>{
  assert.ok(!operation.includes('vehicleHref'),'the operation no longer links to the dossier for the release');
  assert.ok(operation.includes('Confirme la entrega y la liberación en este folio'));
});
