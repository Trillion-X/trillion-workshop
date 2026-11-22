// tool:choose-the-workflows-that-fire's answer is held in the router's run and carried in every later envelope, and
// tool:run-a-workflow refuses a run past 32,768 bytes (workflow-component MOST_ANSWER_BYTES). From 6:29 AM CST Nov 22 2026
// every route-each-row-change run failed at its choose step: the answer named 156 unconditioned workflows by label and
// every part a condition could not read, and the run came to 43,056 bytes. The answer now carries what the router's next
// steps bind (and the score wf find ranks by), and counts the lists; explain: true still names them. Made-up rows.
import { PGlite } from '@electric-sql/pglite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAsTheTool } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';

const CARRY = 32 * 1024;
const ROUTER = JSON.parse(readFileSync(new URL('../recipes/route-each-row-change.json', import.meta.url), 'utf8')).records[0].payload;
const HOME = 'home-connection';
const SHOP = 'shop-connection';
const bytes = value => Buffer.byteLength(JSON.stringify(value));

const rule = (field, values) => ({ kind: 'rule', field, operator: 'is_any_of', params: { values } });
const when = (label, place) => ({ label, state: 'On', made_by: 'the person', because: 'x'.repeat(400), input: { start_at: 'do' },
  condition: { fields: ['place', 'change', 'where'].map(id => ({ id, kind: 'choice', path: [id] })),
    tree: { kind: 'group', combinator: 'and', negate: false, rules: [rule('place', [place]), rule('change', ['added']), rule('where', [SHOP])] } } });
const steps = { steps: [{ id: 'do', kind: 'ask', config: { name: 'tool:run-sql-in-my-database', input: { sql: 'select 1' } } }], edges: [] };
const part = { place: 'payment_events', change: 'added', where: SHOP, after: { id: 'pay_1' } };

// n of the person's own rows, each kept in its store, each with a condition a payment row meets. The ids (47 characters),
// the condition labels (59) and the store's name (35) are as long as a live pursuit's own rows average (Nov 22
// 2026: 518 conditions, ids 47, labels 62). Each choice then answers in about 250 bytes: workflow, condition and kept_in
// alone, the values the router binds, take 141, so no answer that names each choice holds 200 of them under the carry.
const KEPT = 'pursuit_one_for_who_runs_it-connect';
const keptRows = n => Array.from({ length: n }, (_, at) => {
  const recipe = `workflow:answer-a-paid-buyer-in-their-own-w-${String(at).padStart(3, '0')}`;
  return { id: recipe, value: { recipe, title: `Answer a paid buyer in their own words, number ${at}`, kept_in: KEPT, definition: steps,
    fires_when: [when(`a payment row is added in the shop for the buyer number ${String(at).padStart(3, '0')}`, 'payment_events')] } };
});

test('100 chosen workflows answer with 4 KB of the carry to spare, and explain names what the counts count', async () => {
  const own = keptRows(100);
  const answer = await chooseTheWorkflowsThatFire({ parts: [part], own, within: [ROUTER.id] });
  const chosenOwn = answer.chosen.filter(item => item.kept_in === KEPT);
  assert.equal(chosenOwn.length, 100);
  const size = bytes(answer);
  assert.ok(size < CARRY - 4096, `100 chosen answer in ${size} bytes, 4 KB under ${CARRY}`);
  assert.deepEqual(Object.keys(chosenOwn[0]).sort(), ['condition', 'input', 'installed', 'kept_in', 'part', 'rank', 'score', 'workflow']);
  assert.ok(chosenOwn.every(item => item.definition === undefined), 'a row kept in its store hands on no definition: the starter reads it there');
  assert.equal(answer.unconditioned, undefined);
  assert.ok(answer.named.unconditioned > 0, 'the installed workflows with no condition are counted');

  const explained = await chooseTheWorkflowsThatFire({ parts: [part], own, within: [ROUTER.id], explain: true });
  assert.ok(bytes(explained) > CARRY, `the explained answer (${bytes(explained)} bytes) is the one that would not fit`);
  for (const name of ['unfinished', 'unconditioned', 'broad', 'unmatched_parts']) assert.equal(answer.named[name], explained[name].length, name);
  assert.deepEqual(explained.chosen.map(({ workflow, part: at, condition, input, installed, score, rank, kept_in }) => ({ workflow, part: at, condition, input, installed, score, rank, kept_in })),
    answer.chosen.map(({ workflow, part: at, condition, input, installed, score, rank, kept_in }) => ({ workflow, part: at, condition, input, installed, score, rank, kept_in })), 'explain adds why, never changes what is chosen');
  assert.ok(explained.chosen.every(item => typeof item.from === 'string' && Array.isArray(item.matched)));
  await assert.rejects(chooseTheWorkflowsThatFire({ parts: [part], explain: 'yes' }), /explain must be true or false/);
});

test('a chosen own row the caller handed with its definition and no kept_in still hands the definition on', async () => {
  const [row] = keptRows(1);
  const { kept_in: _, ...unkept } = row.value;
  const answer = await chooseTheWorkflowsThatFire({ parts: [part], own: [{ id: row.id, value: unkept }], installed: false });
  assert.deepEqual(answer.chosen[0].definition, steps);
  assert.equal(answer.chosen[0].kept_in, undefined);
});

// The router, run on the workflow engine as the engine runs its row, with its read on a real database (PGlite): the
// chooser is answered once in the carried form and once explained (the answer before this change, which named everything),
// and the steps after choose must ask and tell exactly the same.
async function routeWith(explain) {
  const db = new PGlite();
  await db.exec('CREATE TABLE workflow_recipes (recipe text PRIMARY KEY, title text, fires_when jsonb, definition jsonb)');
  await db.query('INSERT INTO workflow_recipes VALUES ($1, $1, $2, $3)', ['workflow:greet-a-paid-buyer', JSON.stringify([when('a payment row is added in the shop', 'payment_events')]), JSON.stringify(steps)]);
  const asked = [], told = [];
  let chosen;
  const door = {
    async run(name, input) {
      if (name === 'tool:choose-the-workflows-that-fire') { chosen = await chooseTheWorkflowsThatFire({ ...input, ...(explain ? { explain } : {}) }); return chosen; }
      if (name !== 'tool:run-sql-in-my-database') throw new Error(`no stand-in for ${name}`);
      asked.push(input);
      if (input.credential_name !== HOME) return { columns: [], rows: [], row_count: 0 };
      const answer = await db.query(input.sql, (input.params ?? []).map(value => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? null)));
      return { columns: answer.fields.map(field => field.name), rows: answer.rows, row_count: answer.rows.length };
    },
    async operation(name, input) { told.push(input); return { result: { admitted: true } }; },
  };
  const fact = { kind: 'something-changed', where: SHOP, place: 'payment_events', change: 'added', at: '2026-11-22T13:00:00.000Z', key: `${SHOP}:41:7`, after: JSON.stringify({ id: 'pay_1' }) };
  const run = await runAsTheTool({ run: { row: ROUTER.id, own: { credential_name: HOME }, ...ROUTER.wakes[0].input }, woken_by: { kind: 'something-changed', event_id: 'fact-payment_events-added', payload: fact, coalesced: 0 } }, door);
  return { run, asked, told, chosen };
}

test('tell-installed and start-from-rows get the same values from the carried answer as from the explained one', async () => {
  const [slim, full] = [await routeWith(false), await routeWith(true)];
  assert.equal(slim.run.status, 'completed', slim.run.error_message);
  assert.equal(full.run.status, 'completed', full.run.error_message);
  assert.ok(slim.told.some(fact => fact.kind === 'workflow-chosen'), 'an installed workflow is told');
  assert.ok(slim.told.some(fact => fact.kind === 'workflow-chosen-from-rows' && fact.payload.workflow === 'workflow:greet-a-paid-buyer'), 'the own row is started from where it is kept');
  assert.deepEqual(slim.told, full.told);
  assert.deepEqual(slim.asked, full.asked);
  assert.ok(bytes(slim.chosen) < bytes(full.chosen));
});

test('a row change part\'s store goes on in each choice\'s input, a message part gives none, and a condition\'s own input wins', async () => {
  const store = { credential_name: KEPT };
  const own = [{ id: 'workflow:a', value: { recipe: 'workflow:a', fires_when: [{ ...when('a payment row', 'payment_events'), input: {} }] } },
    { id: 'workflow:b', value: { recipe: 'workflow:b', fires_when: [{ ...when('a payment row, its own store', 'payment_events'), input: { start_at: 'do', store: { credential_name: 'its-own-connection' } } }] } }];
  const inputOf = (answer, id) => answer.chosen.find(item => item.workflow === id).input;
  const changed = await chooseTheWorkflowsThatFire({ parts: [{ ...part, store }], own, installed: false });
  assert.deepEqual(inputOf(changed, 'workflow:a'), { store });
  assert.deepEqual(inputOf(changed, 'workflow:b'), { start_at: 'do', store: { credential_name: 'its-own-connection' } }, 'the condition\'s input wins');
  const message = await chooseTheWorkflowsThatFire({ parts: [part], own, installed: false });
  assert.deepEqual(inputOf(message, 'workflow:a'), {}, 'a part with no store gives none, and its where is never taken for one');
});
