// The rows of tours-screen over made-up tours, progress and show rules, against the records door stand-in
// (tools/records-door/test/fake-door.mjs), which checks the rows' rights the way the engine does. Made-up rows only;
// nothing here names a person, and the labels, the starting rules and the show-rules subject are read from DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow, rowOf } from '../../records-door/test/run-row.mjs';
import settings from '../read-data/tours.json' with { type: 'json' };
import showRules from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import { foldWalkthroughProgress } from '../read-data/walkthrough-eeaf.ts';
import { TOUR_SUBJECT } from '../do-work/tours.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const row = slug => rowOf(ROWS, `tool:${slug}`);
const NOW = '2026-01-10T12:00:00.000Z';
const step = id => ({ id, content: { content_kind: 'text', payload: { title: `Sample ${id}`, body: 'A sample step.' } } });
const tour = (id, extra = {}) => ({
  kind: 'walkthrough-definition', id, revision: 1, title: `Sample ${id}`, entry_step: 'one', steps: [step('one'), step('two')],
  triggers: [{ reason: 'first-use', on_event: { event_kind: 'app-opened' }, once_key: `${id}-seen` }], ...extra,
});
const OWN = [tour('own-a', { order: 2 }), tour('own-b', { order: 1 })];
// Starting rules switched off, so only the rules a test keeps decide.
const QUIET = { rules: [], starting: Object.fromEntries(showRules.starting_rules.map(one => [one.id, false])) };
const records = ({ own = OWN, progress = null, rules = QUIET } = {}) => ({
  [settings.tours_label]: own, ...(progress ? { [settings.progress_label]: progress } : {}), ...(rules ? { [showRules.record]: rules } : {}),
});
const run = (slug, input, held) => runRow(row(slug), { now: NOW, ...input }, { doorOptions: { workspaceRecords: held } });

test('every action is one row, and every row only reads the tours, the progress and the show rules', () => {
  assert.deepEqual(ROWS.records.map(one => one.payload.id), ['tool:list-workspace-tours', 'tool:list-waiting-tours', 'tool:dismiss-waiting-tours']);
  for (const one of ROWS.records.map(record => record.payload)) {
    const rights = one.invoke.records.rights;
    assert.deepEqual(rights.map(right => right.id).sort(), [settings.tours_label, settings.progress_label, showRules.record].sort(), one.id);
    for (const right of rights) assert.deepEqual(right.operations, ['workspace:read'], `${one.id} claims no workspace write`);
  }
  assert.ok(showRules.subjects[TOUR_SUBJECT], 'a tour is decided as a show-rules subject');
});

test('list: every tour in its order, with the app\'s own when passed, and whether each is finished', async () => {
  const progress = { kind: 'walkthrough-progress', consumed_once_keys: [], cursors: { 'own-a': { run_id: 'r', current_step_id: 'two', status: 'complete', cursor_revision: 2 } }, transitions: [] };
  const answer = await run('list-workspace-tours', { tours: [tour('app-tour', { order: 0 })] }, records({ progress }));
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.tours.map(one => one.tour_id), ['app-tour', 'own-b', 'own-a']);
  assert.deepEqual(answer.result.tours.map(one => one.finished), [false, false, true]);
  assert.deepEqual(answer.result.tours.map(one => one.own), [false, true, true]);
  assert.equal(answer.result.tours[0].steps, 2);
});

test('list with no tours kept answers none, and refuses tours that are not a list', async () => {
  const none = await run('list-workspace-tours', {}, {});
  assert.equal(none.status, 0, none.error);
  assert.deepEqual(none.result.tours, []);
  const bad = await run('list-workspace-tours', { tours: 'all' }, {});
  assert.notEqual(bad.status, 0);
  assert.match(bad.error, /tours is a list/);
});

test('waiting: a tour whose key is consumed no longer waits; a kept hide rule holds the rest, with the rule named', async () => {
  const progress = { kind: 'walkthrough-progress', consumed_once_keys: ['own-a-seen'], consumed_at: { 'own-a-seen': '2026-01-09T00:00:00.000Z' }, cursors: {}, transitions: [] };
  const open = await run('list-waiting-tours', {}, records({ progress }));
  assert.equal(open.status, 0, open.error);
  assert.deepEqual(open.result.waiting.map(one => one.tour_id), ['own-b']);
  assert.equal(open.result.waiting[0].held, false);
  assert.equal(open.result.waiting[0].once_key, 'own-b-seen');
  assert.equal(open.result.waiting[0].facts.reason, 'first-use');
  const hide = { id: 'sample-hide', label: 'Sample hide', subject: TOUR_SUBJECT, when: null, effect: 'hide', on: true };
  const held = await run('list-waiting-tours', {}, records({ progress, rules: { ...QUIET, rules: [hide] } }));
  assert.equal(held.result.waiting[0].held, true);
  assert.deepEqual(held.result.waiting[0].held_by.map(one => one.id), ['sample-hide']);
});

test('waiting for another event: none of these tours starts on it', async () => {
  const answer = await run('list-waiting-tours', { event: { event_kind: 'screen-opened' } }, records());
  assert.deepEqual(answer.result.waiting, []);
});

test('dismiss: one progress move consumes every waiting tour\'s key, answered as keep over the record read', async () => {
  const answer = await run('dismiss-waiting-tours', {}, records());
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.dismissed.sort(), ['own-a', 'own-b']);
  assert.equal(answer.result.keep.length, 1);
  const [kept] = answer.result.keep;
  assert.equal(kept.label, settings.progress_label);
  assert.equal(kept.expected, null);
  assert.deepEqual(kept.value.consumed_once_keys, ['own-a-seen', 'own-b-seen']);
  assert.equal(kept.value.consumed_at['own-a-seen'], NOW);
  assert.deepEqual(answer.kept, [], 'the row wrote nothing itself');
  // Once kept, nothing waits.
  const after = await run('list-waiting-tours', {}, records({ progress: kept.value }));
  assert.deepEqual(after.result.waiting, []);
  // The fold reads the kept record as the host does.
  assert.ok(foldWalkthroughProgress([{ address: '', value_json: kept.value }]).consumedOnceKeys.has('own-b-seen'));
});

test('dismiss some: only the named tours, and a tour not waiting is refused in words', async () => {
  const some = await run('dismiss-waiting-tours', { tour_ids: ['own-b'] }, records());
  assert.deepEqual(some.result.dismissed, ['own-b']);
  assert.deepEqual(some.result.keep[0].value.consumed_once_keys, ['own-b-seen']);
  const missing = await run('dismiss-waiting-tours', { tour_ids: ['own-c'] }, records());
  assert.notEqual(missing.status, 0);
  assert.match(missing.error, /Not waiting now: own-c/);
});

test('dismiss with nothing waiting keeps nothing', async () => {
  const answer = await run('dismiss-waiting-tours', {}, records({ own: [] }));
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.keep, []);
});
