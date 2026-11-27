// The rows of tours-screen over made-up tours, progress and show rules handed in the request: no records door is
// given to the run and the rows declare none. Made-up rows only; nothing here names a person, and the labels, the
// starting rules and the show-rules subject are read from DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import settings from '../read-data/tours.json' with { type: 'json' };
import showRules from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import { foldWalkthroughProgress } from '../read-data/walkthrough-eeaf.ts';
import { TOUR_SUBJECT } from '../do-work/tours.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
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
  own_tours: own, ...(progress ? { progress } : {}), ...(rules ? { show_rules: rules } : {}),
});
const run = (slug, input, handed) => answerOf(row(slug), { now: NOW, ...handed, ...input });

test('every action is one row, and no row declares a records door: the tours, the progress and the show rules come in the request', () => {
  assert.deepEqual(ROWS.records.map(one => one.payload.id), ['tool:list-workspace-tours', 'tool:list-waiting-tours', 'tool:dismiss-waiting-tours']);
  for (const one of ROWS.records.map(record => record.payload)) {
    assert.equal(one.invoke.records, undefined, `${one.id} declares no records door`);
    for (const name of ['own_tours', 'progress']) assert.ok(one.input_schema.properties[name], `${one.id} takes ${name}`);
    assert.equal(Boolean(one.input_schema.properties.show_rules), one.id !== 'tool:list-workspace-tours', `${one.id} takes show_rules where it decides holds`);
  }
  assert.equal(settings.tours_label, 'guided-overlay::own-walkthroughs');
  assert.equal(showRules.record, 'show-rules');
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
  assert.deepEqual(answer.kept, [], 'the row wrote nothing');
});

test('list with no tours kept answers none, and refuses tours that are not a list', async () => {
  const none = await run('list-workspace-tours', {});
  assert.equal(none.status, 0, none.error);
  assert.deepEqual(none.result.tours, []);
  const bad = await run('list-workspace-tours', { tours: 'all' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.error, /tours is a list/);
  const badOwn = await run('list-workspace-tours', { own_tours: 'all' });
  assert.match(badOwn.error, /own_tours is the list/);
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

test('each row\'s own sample run answers its result from the records in the sample\'s input, with no records door', async () => {
  for (const one of ROWS.records.map(record => record.payload)) {
    const [sample] = one.verify;
    assert.equal(sample.doorOptions, undefined, `${one.id} sample hands no door`);
    assert.ok(sample.input.own_tours.length > 0, `${one.id} sample carries its tours`);
    const answer = await answerOf(one, sample.input);
    assert.equal(answer.status, 0, answer.error);
    assert.ok(JSON.stringify(answer.result).includes(sample.contains), `${one.id} answers ${sample.contains}`);
  }
});
