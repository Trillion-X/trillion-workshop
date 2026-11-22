// The row-changes leaf with conditions_from: a change is told only when some wake's match or some workflow's condition
// could take it, judged by tool:choose-the-workflows-that-fire itself over a stand-in database's workflow rows. Made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionRowsSql, matchMet, partOf, watchForTransitions } from '../do-work/mechanisms/row-changes.mjs';
import { chooseTheWorkflowsThatFire } from '../../workflows/read-data/choose-the-workflows-that-fire.mjs';

const HERE = 'p_made_up-connection';
const change = (txid, position, op = 'INSERT', table = 'seeds', after = { id: position }) => ({ database: 'p_made_up', txid: String(txid), position: String(position),
  at: '2026-11-22T12:08:00Z', table_name: table, op, before: op === 'INSERT' ? null : { id: position }, after: op === 'DELETE' ? null : after, by: null });
// One On condition over the change's place, change and where, as a person's workflow row holds it.
const condition = (label, { place, change: kinds, where = [HERE], extra = [] }) => ({
  label, made_by: 'fires_when', state: 'On', input: { start_at: 'first' },
  condition: {
    fields: [{ id: 'place', kind: 'choice', path: ['place'] }, { id: 'change', kind: 'choice', path: ['change'] }, { id: 'where', kind: 'choice', path: ['where'] },
      ...extra.map(({ field }) => field)],
    tree: { kind: 'group', combinator: 'and', negate: false, rules: [
      { kind: 'rule', field: 'place', operator: 'is_any_of', params: { values: place } },
      { kind: 'rule', field: 'change', operator: 'is_any_of', params: { values: kinds } },
      { kind: 'rule', field: 'where', operator: 'is_any_of', params: { values: where } },
      ...extra.map(({ rule }) => rule)] },
  },
});
const row = (recipe, ...conditions) => ({ id: recipe, value: { recipe, fires_when: conditions } });
const SEED_ADDED = row('workflow:made-up-take-a-seed-apart', condition('a seed is added', { place: ['seeds'], change: ['added'] }));
// The real chooser over the rows given, without the installed recipes (which also leaves out a row whose id an installed
// recipe holds, so every id here is made up): the test names every condition there is.
const choose = input => chooseTheWorkflowsThatFire({ ...input, installed: false });

// A stand-in client: the committed changes after the place asked, the workflow rows, and how often each was read.
function client(changes, rows) {
  const asked = { reads: 0, conditions: 0 };
  const stand = {
    asked,
    // Called when the leaf is caught up and about to wait for the next notice.
    idle: () => {},
    on: () => {},
    query: async (sql, params = []) => {
      if (sql === conditionRowsSql) { asked.conditions += 1; return { rows }; }
      if (sql.startsWith('LISTEN')) return { rows: [] };
      if (sql.includes('AS waiting')) { stand.idle(); return { rows: [{ xmin: '1', waiting: 0, database: 'p_made_up', holder: null }] }; }
      if (sql.includes('ORDER BY txid DESC')) return { rows: [] };
      asked.reads += 1;
      const [txid, position, limit] = params;
      const after = c => txid === null || BigInt(c.txid) > BigInt(txid) || (c.txid === txid && BigInt(c.position) > BigInt(position));
      return { rows: changes.filter(after).sort((a, b) => Number(BigInt(a.txid) - BigInt(b.txid)) || Number(a.position) - Number(b.position)).slice(0, limit) };
    },
    end: async () => {},
  };
  return stand;
}
// One pass of the leaf: it ends once the pass is caught up and the leaf waits for the next notice.
async function onePass(stand, { wakes = [], conditionsFrom = HERE, where = HERE, settings = {}, hearing } = {}) {
  const control = new AbortController();
  const told = [];
  const said = [];
  let kept = null;
  const done = watchForTransitions({ look_again_seconds: 3600, from_the_start: true, ...settings }, {
    connection: 'postgresql://made-up', connect: async () => stand, signal: control.signal, state: null,
    where, conditionsFrom, kind: 'something-changed', choose,
    hearing: hearing ?? (async kind => (kind === 'something-changed' ? wakes : [])),
    keepState: async value => { kept = value; },
    say: line => { said.push(line); },
    onTransition: async transition => { told.push(transition); return true; },
  });
  // Stopped just after the leaf starts its wait, so the wait itself hears the stop.
  stand.idle = () => setTimeout(() => control.abort(), 20);
  await done;
  const counts = said.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  return { told, said, kept, counts };
}

test('an added seed that a condition watches for is told', async () => {
  const stand = client([change(9, 1, 'INSERT')], [SEED_ADDED]);
  const { told, counts } = await onePass(stand);
  assert.deepEqual(told.map(item => item.event_key), ['p_made_up:9:1']);
  assert.deepEqual(counts, [{ 'row-changes': HERE, told: 1, not_told: 0, judged: true }]);
});

test('a changed seed that only "added" conditions watch is not told, and the kept place moves past it', async () => {
  const stand = client([change(9, 1, 'UPDATE'), change(9, 2, 'INSERT'), change(10, 1, 'UPDATE')], [SEED_ADDED]);
  const { told, kept, counts } = await onePass(stand);
  assert.deepEqual(told.map(item => item.event_key), ['p_made_up:9:2'], 'only the add is told');
  assert.deepEqual(kept, { after: { txid: '10', position: '1' } }, 'the last change, not told, is the kept place');
  assert.deepEqual(counts, [{ 'row-changes': HERE, told: 1, not_told: 2, judged: true }]);
});

test('a change in another database than the one a condition names is not told', async () => {
  const other = 'p_other-connection';
  const stand = client([change(9, 1, 'INSERT')], [SEED_ADDED]);
  const { told, counts } = await onePass(stand, { where: other, conditionsFrom: other });
  assert.deepEqual(told, []);
  assert.deepEqual(counts, [{ 'row-changes': other, told: 0, not_told: 1, judged: true }]);
});

test('a condition the chooser cannot judge (a label and no tree) keeps every change told, and is named', async () => {
  const labelOnly = { id: 'workflow:made-up-judged-by-words', value: { recipe: 'workflow:made-up-judged-by-words', fires_when: [{ label: 'when something seems worth it', made_by: 'the person', state: 'On' }] } };
  const stand = client([change(9, 1, 'UPDATE'), change(9, 2, 'DELETE')], [SEED_ADDED, labelOnly]);
  const { told, said, counts } = await onePass(stand);
  assert.deepEqual(told.map(item => item.event_key), ['p_made_up:9:1', 'p_made_up:9:2']);
  assert.ok(said.some(line => line.includes('workflow:made-up-judged-by-words') && line.includes('when something seems worth it')), said.join('\n'));
  assert.deepEqual(counts, [{ 'row-changes': HERE, told: 2, not_told: 0, judged: true }]);
});

test('a burst of 2,000 changed seeds tells none, reads the conditions once for the pass, and keeps the last place', async () => {
  const burst = Array.from({ length: 2000 }, (_, at) => change(100 + Math.floor(at / 10), (at % 10) + 1, 'UPDATE'));
  const stand = client(burst, [SEED_ADDED]);
  const { told, kept, counts } = await onePass(stand);
  assert.equal(told.length, 0);
  assert.equal(stand.asked.reads, 5, 'four full reads of 500 and the read that finds it caught up');
  assert.equal(stand.asked.conditions, 1, 'the workflow rows are read once a pass, not once a read or a row');
  assert.deepEqual(kept, { after: { txid: '299', position: '10' } });
  assert.deepEqual(counts, [{ 'row-changes': HERE, told: 0, not_told: 2000, judged: true }]);
});

test('a change no condition takes is told when a wake that hears it has a match it meets', async () => {
  const tasks = { tool: 'tool:run-a-workflow', id: 'a-task-row-changed', switched_on: false, on: { fact: { from: ['run'], kind: 'something-changed', match: { place: 'calendar_tasks' } } } };
  const router = { tool: 'workflow:route-each-row-change', id: 'a-row-changed', switched_on: false, on: { fact: { from: ['run'], kind: 'something-changed' } } };
  const stand = client([change(9, 1, 'UPDATE', 'calendar_tasks'), change(9, 2, 'UPDATE', 'seeds')], [SEED_ADDED]);
  const { told, counts } = await onePass(stand, { wakes: [router, tasks] });
  assert.deepEqual(told.map(item => item.detail.place), ['calendar_tasks'], 'the wake with no match (the router) takes nothing by itself');
  assert.deepEqual(counts, [{ 'row-changes': HERE, told: 1, not_told: 1, judged: true }]);
  assert.equal(matchMet({ on: { fact: { match: { dispatched: true } } } }, { dispatched: true }), false, 'a fact carries text, so a match on a non-text value is never met');
});

test('a condition over a field of the row after the change is judged on the carried after', async () => {
  const piece = { field: { id: 'state', kind: 'choice', path: ['after', 'state'] }, rule: { kind: 'rule', field: 'state', operator: 'is_any_of', params: { values: ['ready'] } } };
  const ready = row('workflow:made-up-fill-a-piece', condition('a piece is ready', { place: ['product_stage'], change: ['changed'], extra: [piece] }));
  const stand = client([change(9, 1, 'UPDATE', 'product_stage', { state: 'drafting' }), change(9, 2, 'UPDATE', 'product_stage', { state: 'ready' })], [ready]);
  const { told } = await onePass(stand);
  assert.deepEqual(told.map(item => item.event_key), ['p_made_up:9:2']);
  assert.deepEqual(partOf(change(9, 2, 'UPDATE', 'product_stage', { state: 'ready' }), HERE),
    { where: HERE, place: 'product_stage', change: 'changed', before: { id: 2 }, after: { state: 'ready' }, kinds: null });
});

test('every change is told when conditions_from is another database, when it is left out, or when the wakes cannot be listed', async () => {
  const changes = [change(9, 1, 'UPDATE'), change(9, 2, 'UPDATE')];
  const elsewhere = await onePass(client(changes, [SEED_ADDED]), { conditionsFrom: 'p_elsewhere-connection' });
  assert.equal(elsewhere.told.length, 2);
  assert.ok(elsewhere.said.some(line => line.includes('conditions_from p_elsewhere-connection is not the database this waiter reads')));
  const unnamed = await onePass(client(changes, [SEED_ADDED]), { conditionsFrom: null });
  assert.equal(unnamed.told.length, 2);
  const unlisted = await onePass(client(changes, [SEED_ADDED]), { hearing: async () => null });
  assert.equal(unlisted.told.length, 2);
  assert.ok(unlisted.said.some(line => line.includes('every change of this pass is told')));
  assert.deepEqual(unlisted.counts, [{ 'row-changes': HERE, told: 2, not_told: 0, judged: false }]);
});
