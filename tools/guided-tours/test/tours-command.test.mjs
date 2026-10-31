// tools/guided-tours: the four commands, run the way the tool container runs them, over a made-up bakery tour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = new URL('../do-work/tours.mjs', import.meta.url).pathname;
const run = async (verb, input) => {
  const pending = exec('node', [script, verb]);
  pending.child.stdin.end(JSON.stringify(input));
  const done = await pending.catch(error => error);
  return { status: done.code ?? 0, answer: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
};

const tour = {
  kind: 'walkthrough-definition',
  id: 'tour:bakery',
  entry_step: 'hello',
  steps: [
    { id: 'hello', content: { title: 'Welcome' }, branch_map: { by_answer: { baker: 'oven', guest: 'menu' }, default_next: 'menu' } },
    { id: 'menu', content: { title: 'The menu' } },
    { id: 'oven', content: { title: 'The oven' } },
  ],
  triggers: [
    { reason: 'first-visit', on_event: { event_kind: 'shop-opened' }, once_key: 'tour:bakery' },
    { reason: 'replay', on_event: { event_kind: 'tour-requested', match: { walkthrough_id: 'tour:bakery' } } },
  ],
};

test('step walks a tour: start, an answer routes, back undoes, the end finishes', async () => {
  const start = (await run('step', { tour, action: 'start' })).answer.result;
  assert.deepEqual(start.cursor, { current_step_id: 'hello', history: [], status: 'active' });
  assert.equal(start.step.content.title, 'Welcome');
  assert.equal(start.finished, false);
  const baker = (await run('step', { tour, action: 'advance', cursor: start.cursor, answer: 'baker' })).answer.result;
  assert.equal(baker.cursor.current_step_id, 'oven');
  const back = (await run('step', { tour, action: 'back', cursor: baker.cursor })).answer.result;
  assert.equal(back.cursor.current_step_id, 'hello');
  const jumped = (await run('step', { tour, action: 'jump', cursor: back.cursor, step_id: 'menu' })).answer.result;
  assert.deepEqual([jumped.cursor.current_step_id, jumped.cursor.history], ['menu', ['hello']]);
  const end = (await run('step', { tour, action: 'advance', cursor: { current_step_id: 'oven', history: [], status: 'active' } })).answer.result;
  assert.deepEqual([end.finished, end.cursor.status, end.step.id], [true, 'complete', 'oven']);
});

test('may-advance answers from the signals, in the names a caller writes', async () => {
  const both = { op: 'all-of', args: { of: [{ op: 'media-watched', args: { min_ratio: 0.9 } }, { op: 'answer-given' }] } };
  assert.equal((await run('may-advance', { condition: both, signals: { media_ratio: 0.95, answer: 'x' } })).answer.result.may_advance, true);
  assert.equal((await run('may-advance', { condition: both, signals: { media_ratio: 0.95 } })).answer.result.may_advance, false);
  const fact = { op: 'owner-readback', args: { readback_ref: 'oven', required_nonempty: true } };
  assert.equal((await run('may-advance', { condition: fact, signals: { owner_readbacks: { oven: ['hot'] } } })).answer.result.may_advance, true);
  assert.equal((await run('may-advance', { condition: { op: 'tap-next' } })).answer.result.may_advance, false);
});

test('find picks the tour an event starts, with the key to record, and nothing once the key is used up', async () => {
  const hit = (await run('find', { tours: [{ value_json: tour }], event: { event_kind: 'shop-opened' } })).answer.result;
  assert.deepEqual([hit.tour_id, hit.trigger.reason, hit.suppression_key], ['tour:bakery', 'first-visit', 'tour:bakery']);
  const used = (await run('find', { tours: [{ value_json: tour }], event: { event_kind: 'shop-opened' }, consumed_keys: ['tour:bakery'] })).answer.result;
  assert.deepEqual(used, { tour_id: null, trigger: null, suppression_key: null });
});

test('start-event gives the event a Start button sends for one tour', async () => {
  const { answer } = await run('start-event', { tours: [tour], tour_id: 'tour:bakery' });
  assert.deepEqual(answer.result.event, { event_kind: 'tour-requested', walkthrough_id: 'tour:bakery' });
});

test('requests that cannot be read are refused with what to fix', async () => {
  assert.match((await run('step', { tour: { steps: [] }, action: 'start' })).answer.error, /entry_step/);
  assert.match((await run('step', { tour: { entry_step: 'x', steps: [{ id: 'a' }] }, action: 'start' })).answer.error, /no step x/);
  assert.match((await run('step', { tour, action: 'advance' })).answer.error, /needs the cursor/);
  assert.match((await run('step', { tour, action: 'advance', cursor: { current_step_id: 'x' } })).answer.error, /cursor must be/);
  assert.match((await run('step', { tour, action: 'dance' })).answer.error, /action must be/);
  assert.match((await run('step', { tour, action: 'jump', cursor: { current_step_id: 'hello', history: [], status: 'active' } })).answer.error, /step_id/);
  assert.match((await run('find', { tours: 'no', event: { event_kind: 'a' } })).answer.error, /tours must be/);
  assert.match((await run('find', { tours: [], event: {} })).answer.error, /event_kind/);
  assert.match((await run('start-event', { tours: [], tour_id: 'ghost' })).answer.error, /no tour ghost/);
  assert.match((await run('replay', {})).answer.error, /use step, may-advance, find or start-event/);
  assert.equal((await run('replay', {})).status, 1);
});
