// A change the noticer tells in its 1b shape (where, place, change) reaches the chooser the way route-each-row-change
// builds its part, and chooses the workflow whose condition names that place and change, and no other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';

// The part route-each-row-change's choose step builds from a something-changed fact.
const partOf = fact => ({ where: fact.where, place: fact.place, change: fact.change, before: fact.before ?? null, after: fact.after ?? null });
const fact = (place, change) => ({ kind: 'something-changed', where: 'own-rows-postgres-connection', place, change, at: '2026-11-18T20:00:00.000Z', key: `d:7:${place}`, before: null, after: JSON.stringify({ id: 9 }) });
const chosenFor = async f => (await chooseTheWorkflowsThatFire({ parts: [partOf(f)], within: ['workflow:route-each-row-change'] })).chosen;

test('an added broad_condition row chooses workflow:rewrite-a-broad-condition by its condition', async () => {
  const chosen = await chosenFor(fact('broad_condition', 'added'));
  assert.ok(chosen.some(item => item.workflow === 'workflow:rewrite-a-broad-condition' && item.condition === 'a broad_condition row is added'),
    JSON.stringify(chosen.map(item => [item.workflow, item.label])));
});

test('an added recording row chooses the workflow whose condition names recording', async () => {
  const chosen = await chosenFor(fact('recording', 'added'));
  assert.ok(chosen.some(item => item.workflow === 'workflow:turn-one-long-recording-into-many-pieces'), JSON.stringify(chosen.map(item => [item.workflow, item.label])));
});

test('a changed row (not added) does not choose the added-only condition', async () => {
  const chosen = await chosenFor(fact('broad_condition', 'changed'));
  assert.equal(chosen.some(item => item.workflow === 'workflow:rewrite-a-broad-condition'), false);
});

test('a place no condition names chooses no added-only workflow, only the history keeper, which keeps what its own rules name', async () => {
  const chosen = await chosenFor(fact('nothing_names_this', 'added'));
  assert.deepEqual(chosen.map(item => item.workflow), ['workflow:keep-each-told-change-in-the-history'], JSON.stringify(chosen.map(item => [item.workflow, item.label])));
});
