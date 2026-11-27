import { heldOf, run } from './fixtures.mjs';
// The page's /work/api/pursuits route (tool:answer-the-pursuits-page), with old trillion's tests at tag
// old-trillion-before-worker-retire ported to it: test/work-pursuits.test.mjs (Home's add-a-goal form and "Make this my
// needle mover" save through PUT /work/api/pursuits; a refusal comes back in the engine's words) and the recordPursuits
// part of test/pursuits.test.mjs (third-person words refused; one AI updating one pursuit never ends the others;
// replace_all ends every pursuit left out, which is marked ended, not erased). The owner runs over a memory door first,
// then the row runs on the records its call hands in.
//
// Left out, with why: work-pursuits' "another page may not write" (403 for a foreign Origin) is the engine door's check
// on the page's session, not this tool's: the tool is never handed the request's Origin header. pursuits.test.mjs's
// decision steps (pursuits travelling with the change question, cited pursuits) are tools/decide-with-a-method's own
// tests already, and its record-log history read (valuesAt) is the engine store's, not the door's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { answerThePursuitsPage, pursuitsOf } from '../do-work/answer-the-pursuits-page.mjs';

// The pursuit tools as their caller plays them: each read takes the records the store holds now, and each write keeps what
// the tool answers as `keep` (the store applies it, refusing a record that moved).
const engineOf = door => ({
  pursuits: () => pursuitsOf(heldOf(door)).pursuits(),
  recordPursuits(list, options) {
    const written = pursuitsOf(heldOf(door)).recordPursuits(list, options);
    if (written.keep.length) door.write(written.keep);
    return written;
  },
});

// The caller's store: every record it holds (`all`), and a write of what the tool keeps, each record checked against
// `expected` and the whole write refused when one moved.
function memoryDoor(records = []) {
  const kept = new Map(records.map(record => [record.id, structuredClone(record)]));
  const history = [];
  return {
    kept,
    history,
    all() { return [...kept.values()].map(({ id, type, value }) => structuredClone({ id, type, value })); },
    write(rows) {
      for (const row of rows) {
        const now = kept.get(row.id);
        if ('expected' in row && JSON.stringify(row.expected) !== JSON.stringify(now ? { type: now.type, value: now.value } : null)) throw Object.assign(new Error('The records changed while this tool was running.'), { code: 'original_command_conflict' });
      }
      for (const row of rows) {
        history.push({ id: row.id, value: structuredClone(row.value) });
        if (row.value === null) kept.delete(row.id); else kept.set(row.id, { id: row.id, type: row.type, value: structuredClone(row.value) });
      }
      return { changed: rows.length, write_count: 1 };
    },
  };
}
const put = (door, body) => run(door, answerThePursuitsPage, { path: '/pursuits', method: 'PUT', query: {}, body });
const get = door => run(door, answerThePursuitsPage, { path: '/pursuits', method: 'GET', query: {}, body: {} });

test('a goal added from Home is kept exactly as record_pursuits keeps it', async () => {
  const door = memoryDoor();
  const goal = { title: 'Grow my newsletter', now: '1,200 readers', after: '10,000 readers', why_it_matters: 'It pays for the studio' };
  const added = await put(door, { pursuits: [goal] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const [kept] = (await get(door)).body.pursuits;
  assert.equal(kept.id, 'pursuit:grow-my-newsletter');
  assert.equal(kept.why_it_matters, 'It pays for the studio');
  assert.equal(door.kept.get('pursuit:grow-my-newsletter').type, 'pursuit');
});

test('making a goal the needle mover moves the mark from the goal that had it', async () => {
  const door = memoryDoor();
  const seeded = await put(door, { pursuits: [{ title: 'Pottery studio', now: 'Two students', after: 'Pays the rent', needle_mover: true }, { title: 'Lean and strong', now: '11%', after: '7%' }] });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const kept = (await get(door)).body.pursuits;
  assert.deepEqual(kept.map(({ id, title, now, after }) => ({ id, title, now, after })).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'pursuit:lean-and-strong', title: 'Lean and strong', now: '11%', after: '7%' },
    { id: 'pursuit:pottery-studio', title: 'Pottery studio', now: 'Two students', after: 'Pays the rent' },
  ], 'the actual current read retains both original pursuits and all required fields');
  const pottery = kept.find(item => item.title === 'Pottery studio');
  const lean = kept.find(item => item.title === 'Lean and strong');
  const moved = await put(door, { pursuits: [{ ...lean, needle_mover: true }, { ...pottery, needle_mover: false }] });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const marked = (await get(door)).body.pursuits.filter(item => item.needle_mover).map(item => item.title);
  assert.deepEqual(marked, ['Lean and strong']);
});

test('a refusal comes back in the engine words', async () => {
  const door = memoryDoor();
  const missing = await put(door, { pursuits: [{ title: 'No after', now: 'x' }] });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /where it should get to/);
  const none = await put(door, { pursuits: [] });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /at least one pursuit/);
  assert.equal(door.history.length, 0, 'nothing was written');
});

test('pursuits are written to the person, one AI updating one never ends the others, and one dropped is ended, not erased', async () => {
  const door = memoryDoor();
  const engine = engineOf(door);
  assert.throws(() => engine.recordPursuits([{ title: 'No after', now: 'x' }]), /where it should get to/);
  assert.throws(() => engine.recordPursuits([{ title: 'All his files in the cloud', now: 'On a drive', after: 'In the cloud' }]), /write its title to the person/);
  assert.throws(() => engine.recordPursuits([{ title: 'Your files in the cloud', now: 'On a drive', after: 'Her agents reach them' }]), /write its after to the person/);
  engine.recordPursuits([
    { title: 'Lean and strong', now: '11% body fat', after: '5 to 7% body fat', why_it_matters: 'Energy for everything else' },
    { title: 'Pottery school', now: 'Two paying students', after: 'A school that pays the rent' },
  ]);
  assert.deepEqual(engine.pursuits().map(item => item.title), ['Lean and strong', 'Pottery school']);
  assert.equal(engine.pursuits()[0].id, 'pursuit:lean-and-strong');
  // One AI updating one pursuit, by the id list_pursuits gave it, never ends the others.
  engine.recordPursuits([{ id: 'pursuit:lean-and-strong', title: 'Lean and strong', now: '10.5% body fat', after: '5 to 7% body fat' }]);
  assert.deepEqual(engine.pursuits().map(item => [item.id, item.now]), [['pursuit:lean-and-strong', '10.5% body fat'], ['pursuit:pottery-school', 'Two paying students']]);
  // The whole list, with replace_all, ends every pursuit left out.
  engine.recordPursuits([{ title: 'Lean and strong', now: '10% body fat', after: '5 to 7% body fat' }], { replace_all: true });
  assert.deepEqual(engine.pursuits().map(item => [item.title, item.now]), [['Lean and strong', '10% body fat']]);
  // Each earlier value was written in its turn: the dropped pursuit's status, and the old body fat figure.
  const values = (id, field) => door.history.filter(row => row.id === id).map(row => row.value?.[field]).filter(value => value !== undefined);
  assert.ok(values('pursuit:pottery-school', 'status').includes('ended'));
  assert.deepEqual(values('pursuit:lean-and-strong', 'now'), ['11% body fat', '10.5% body fat', '10% body fat']);
});

test('a pursuit with a room keeps it, and is never ended by a whole-list rewrite', async () => {
  const door = memoryDoor([{ id: 'pursuit:known', type: 'pursuit', value: { id: 'pursuit:known', kind: 'pursuit', title: 'Known room', now: 'Open', after: 'Closed', status: 'active', space_id: 'space_known' } }]);
  const answer = await put(door, { pursuits: [{ title: 'Another', now: 'a', after: 'b' }, { id: 'pursuit:known', title: 'Known room', now: 'Still open', after: 'Closed', space_id: 'space_other' }], replace_all: true });
  assert.equal(answer.status, 200);
  assert.equal(door.kept.get('pursuit:known').value.space_id, 'space_known', 'what an AI sent never moves the room');
  await put(door, { pursuits: [{ title: 'Another', now: 'a', after: 'b' }], replace_all: true });
  assert.equal(door.kept.get('pursuit:known').value.status, 'active');
});

test('only GET and PUT /pursuits are this route', async () => {
  const door = memoryDoor();
  const answered = request => { const { status, body } = run(door, answerThePursuitsPage, request); return { status, body }; };
  assert.deepEqual(answered({ path: '/pursuits', method: 'POST', body: {} }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(answered({ path: '/pursuits/other', method: 'GET', body: {} }), { status: 404, body: { error: 'Not found' } });
});

const row = rowOf(rows, 'tool:answer-the-pursuits-page');
const route = (method, body = {}) => ({ path: '/pursuits', method, query: {}, body, browser: { user_agent: 'test', origin: 'https://app.example', visitor: '' } });

test('the row answers from the records its call hands in: a save answers keep, a read lists what it is handed, a refusal is 400', async () => {
  const saved = await answerOf(row, { ...route('PUT', { pursuits: [{ title: 'Grow my newsletter', now: '1,200 readers', after: '10,000 readers' }] }), records: [] });
  assert.equal(saved.status, 0, JSON.stringify(saved));
  assert.equal(saved.result.status, 200);
  assert.deepEqual(saved.result.body.map(item => item.id), ['pursuit:grow-my-newsletter']);
  assert.deepEqual(saved.result.keep.map(record => [record.id, record.type]), [['pursuit:grow-my-newsletter', 'pursuit']]);
  const held = saved.result.keep.map(({ id, type, value }) => ({ id, type, value }));
  const listed = await answerOf(row, { ...route('GET'), records: held });
  assert.deepEqual(listed.result.body, { pursuits: held.map(record => record.value) });
  assert.deepEqual(listed.result.keep, []);
  const refused = await answerOf(row, { ...route('PUT', { pursuits: [{ title: 'No after', now: 'x' }] }), records: [] });
  assert.equal(refused.result.status, 400);
  assert.match(refused.result.body.error, /where it should get to/);
});
