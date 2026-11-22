// workflow:route-each-row-change chooses the person's own workflow rows beside the installed recipes: its read step runs
// on a real database (PGlite) through a stand-in door that answers tool:run-sql-in-my-database by the store a step names,
// and the run goes on the workflow engine as the engine runs the row. A store with no workflow_recipes table, or none at
// all, reads as no rows. Made-up rows; nothing is sent.
import { PGlite } from '@electric-sql/pglite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAsTheTool } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';

const ROUTER = JSON.parse(readFileSync(new URL('../recipes/route-each-row-change.json', import.meta.url), 'utf8')).records[0].payload;
const READ = ROUTER.definition.uses.find(use => use.id.endsWith(':read-one-store')).steps.find(step => step.id === 'read').config.input.sql;
const KEEP = 'workflow:keep-each-told-change-in-the-history';
const HOME = 'home-connection';
const SHOP = 'shop-connection';

const rule = (field, operator, values) => ({ kind: 'rule', field, operator, params: { values } });
const fields = ids => ids.map(id => ({ id, kind: id === 'kinds' ? 'tags' : 'choice', path: [id] }));
const when = (label, rules, input = { start_at: 'do' }) => ({ label, state: 'On', made_by: 'the person', because: 'x'.repeat(400), input,
  condition: { fields: fields([...new Set(rules.map(item => item.field))]), tree: { kind: 'group', combinator: 'and', negate: false, rules } } });
const paid = when('a payment row is added in the shop', [rule('place', 'is_any_of', ['payment_events']), rule('change', 'is_any_of', ['added']), rule('where', 'is_any_of', [SHOP])]);
const steps = sql => ({ steps: [{ id: 'do', kind: 'ask', config: { name: 'tool:run-sql-in-my-database', input: { sql } } }], edges: [] });

async function store(rows) {
  const db = new PGlite();
  await db.exec('CREATE TABLE workflow_recipes (recipe text PRIMARY KEY, title text, fires_when jsonb, definition jsonb)');
  for (const [recipe, fires, definition] of rows) {
    await db.query('INSERT INTO workflow_recipes VALUES ($1, $2, $3, $4)', [recipe, recipe, fires === null ? null : JSON.stringify(fires), definition === null ? null : JSON.stringify(definition)]);
  }
  return db;
}

// A door that answers tool:run-sql-in-my-database from the store named by credential_name (a store not in `stores`
// fails as a call that ran), the chooser itself, and wake:arrive by keeping what was told.
function door(stores) {
  const calls = [], told = [];
  return {
    calls, told,
    async run(name, input) {
      calls.push({ name, input });
      if (name === 'tool:choose-the-workflows-that-fire') return chooseTheWorkflowsThatFire(input);
      if (name !== 'tool:run-sql-in-my-database') throw new Error(`no stand-in for ${name}`);
      const db = stores[input.credential_name];
      if (!db) throw Object.assign(new Error(`tool:run-sql-in-my-database did not finish: connect ECONNREFUSED (${input.credential_name})`), { outcome: 'committed' });
      const params = (input.params ?? []).map(value => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? null));
      // A statement the database refuses is a run that finished failed, as the engine answers it (host-actions tool_run_failed).
      const answer = await db.query(input.sql, params).catch(error => { throw Object.assign(new Error(error.message), { outcome: 'committed' }); });
      return { columns: answer.fields.map(field => field.name), rows: answer.rows, row_count: answer.rows.length };
    },
    async operation(name, input) { told.push(input); return { result: { admitted: true } }; },
  };
}

const change = (where, place, changed = 'added', kinds = null) => ({ kind: 'something-changed', where, place, change: changed, at: '2026-11-21T11:00:00.000Z', key: `${where}:41:7`, after: JSON.stringify({ id: 'pay_1' }), ...(kinds ? { kinds: JSON.stringify(kinds) } : {}) });
const route = (d, fact, own = { credential_name: HOME }) => runAsTheTool({ run: { row: ROUTER.id, ...(own ? { own } : {}), ...ROUTER.wakes[0].input }, woken_by: { kind: 'something-changed', event_id: `fact-${fact.place}-${fact.change}`, payload: fact, coalesced: 0 } }, d);
const byKind = (d, kind) => d.told.filter(fact => fact.kind === kind).map(fact => fact.payload.workflow).sort();

test('a change only an installed workflow follows tells that workflow by its id and starts nothing from a row', async () => {
  const d = door({ [HOME]: await store([['workflow:greet-a-paid-buyer', [paid], steps('select 1')]]) });
  const run = await route(d, change('own-rows-postgres-connection', 'broad_condition'));
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(byKind(d, 'workflow-chosen'), [KEEP, 'workflow:rewrite-a-broad-condition']);
  assert.deepEqual(byKind(d, 'workflow-chosen-from-rows'), []);
  assert.deepEqual(d.calls.filter(call => call.name === 'tool:run-sql-in-my-database').map(call => call.input.credential_name), [HOME, 'own-rows-postgres-connection'],
    'the switch\'s store and the changed database are read, nothing else');
});

test('a change only the person\'s own row follows starts that row from its own definition, read where the row is kept', async () => {
  const d = door({ [HOME]: await store([['workflow:greet-a-paid-buyer', [paid], steps('select 1')]]) });
  const run = await route(d, change(SHOP, 'payment_events'));
  assert.equal(run.status, 'completed', run.error_message);
  const started = d.told.filter(fact => fact.kind === 'workflow-chosen-from-rows');
  assert.equal(started.length, 1);
  const [{ event_id, payload }] = started;
  assert.equal(event_id, `fact-payment_events-added:workflow:greet-a-paid-buyer:${paid.label}`);
  assert.equal(payload.definition.id, 'workflow:greet-a-paid-buyer');
  assert.deepEqual(payload.definition.steps, steps('select 1').steps, 'the run is the row\'s own definition');
  assert.deepEqual(payload.input, { start_at: 'do', kept_in: { database: 'postgres' } }, 'the condition\'s input, and where the row is kept');
  assert.equal(payload.where, SHOP);
  assert.equal(payload.key, `${SHOP}:41:7`);
  assert.equal(byKind(d, 'workflow-chosen').includes('workflow:greet-a-paid-buyer'), false, 'no installed wake is told for a row nothing installs');
});

test('a change both follow tells the installed one by its id and starts the own row; a pursuit\'s own rows are read in its own database', async () => {
  const shop = await store([['workflow:pack-the-order', [when('a payment is added', [rule('place', 'is_any_of', ['payment_events'])])], steps('select 2')]]);
  const d = door({ [HOME]: await store([['workflow:greet-a-paid-buyer', [paid], steps('select 1')]]), [SHOP]: shop });
  const run = await route(d, change(SHOP, 'payment_events'));
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(byKind(d, 'workflow-chosen'), [KEEP]);
  assert.deepEqual(byKind(d, 'workflow-chosen-from-rows'), ['workflow:greet-a-paid-buyer', 'workflow:pack-the-order']);
  const reads = d.calls.filter(call => call.name === 'tool:run-sql-in-my-database' && call.input.sql.includes('jsonb_build_object(\'id\', recipe'));
  assert.deepEqual(reads.map(call => [call.input.params[0], call.input.credential_name]).sort(), [['workflow:greet-a-paid-buyer', HOME], ['workflow:pack-the-order', SHOP]],
    'each definition is read in the store its row is kept in');
});

test('a change no workflow follows tells nothing', async () => {
  const d = door({ [HOME]: await store([['workflow:greet-a-paid-buyer', [paid], steps('select 1')]]) });
  const run = await route(d, change(SHOP, 'payment_events', 'renamed'));
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(d.told, []);
});

test('an own database that cannot be read, or a switch that names none, still chooses the installed workflows', async () => {
  for (const own of [{ credential_name: 'gone-connection' }, null]) {
    const d = door({});
    const run = await route(d, change('my-booking-service-key', 'broad_condition'), own);
    assert.equal(run.status, 'completed', run.error_message);
    assert.deepEqual(byKind(d, 'workflow-chosen'), [KEEP, 'workflow:rewrite-a-broad-condition']);
    assert.equal(d.calls.some(call => call.name === 'tool:run-sql-in-my-database' && call.input.credential_name === 'my-booking-service-key'), false,
      'a vault name that is no database connection is never read as one');
  }
  const noTable = door({ [HOME]: new PGlite() });
  const run = await route(noTable, change(SHOP, 'broad_condition'));
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(byKind(noTable, 'workflow-chosen'), [KEEP, 'workflow:rewrite-a-broad-condition']);
});

test('an own row that shares an id with an installed recipe is started from its row only when the switch names it over the installed one', async () => {
  const mine = when('a broad condition is added here', [rule('place', 'is_any_of', ['broad_condition'])]);
  const home = await store([['workflow:rewrite-a-broad-condition', [mine], steps('select 3')]]);
  const plain = door({ [HOME]: home });
  assert.equal((await route(plain, change(SHOP, 'broad_condition'))).status, 'completed');
  assert.ok(plain.told.some(fact => fact.kind === 'workflow-chosen' && fact.payload.workflow === 'workflow:rewrite-a-broad-condition' && fact.payload.condition === mine.label), 'the person\'s condition wins');
  assert.deepEqual(byKind(plain, 'workflow-chosen-from-rows'), []);
  assert.ok(plain.told.filter(fact => fact.kind === 'workflow-chosen').every(fact => !('before' in fact.payload)), 'a chosen fact carries no before');
  assert.ok(plain.told.filter(fact => fact.kind === 'workflow-chosen').every(fact => 'after' in fact.payload), 'a chosen fact carries the change\'s after, which a service fact has no row to read back from');
  const over = door({ [HOME]: home });
  assert.equal((await route(over, change(SHOP, 'broad_condition'), { credential_name: HOME, over_installed: ['workflow:rewrite-a-broad-condition'] })).status, 'completed');
  assert.deepEqual(byKind(over, 'workflow-chosen-from-rows'), ['workflow:rewrite-a-broad-condition']);
});

test('the read hands back only the conditions a change could meet, so 600 rows answer in a few KB', async () => {
  const rows = [];
  for (let n = 0; n < 600; n += 1) {
    const kind = n % 5 === 0 ? [rule('place', 'is_any_of', [`table_${n}`]), rule('change', 'is_any_of', ['added'])] : [rule('kinds', 'has_any_of', [`kind-${n}`])];
    rows.push([`workflow:w-${String(n).padStart(3, '0')}`, [when(`condition ${n}`, kind)], n % 2 ? steps(`select ${n}`) : null]);
  }
  rows.push(['workflow:any-change', [when('any change at all', [{ kind: 'rule', field: 'place', operator: 'is_not_empty' }])], steps('select 0')]);
  rows.push(['workflow:off-switched', null, null]);
  const db = await store(rows);
  const read = async (place, changed, kinds) => (await db.query(READ, [place, changed, SHOP, kinds, HOME, null])).rows;
  const one = await read('table_10', 'added', null);
  assert.deepEqual(one.map(row => row.id), ['workflow:any-change', 'workflow:w-010']);
  assert.ok(JSON.stringify(one).length < 4096, `${JSON.stringify(one).length} bytes`);
  assert.equal(one.find(row => row.id === 'workflow:w-010').value.kept_in, undefined, 'a row with no definition of its own names no store to start it from');
  assert.equal(one.find(row => row.id === 'workflow:any-change').value.kept_in, HOME);
  assert.equal(JSON.stringify(one).includes('xxxx'), false, 'a condition\'s reasons stay in the store');
  assert.deepEqual((await read('table_10', 'changed', null)).map(row => row.id), ['workflow:any-change']);
  assert.deepEqual((await read('anything', 'added', JSON.stringify(['kind-7', 'kind-8']))).map(row => row.id), ['workflow:any-change', 'workflow:w-007', 'workflow:w-008']);
  const all = await read(null, null, null);
  assert.ok(JSON.stringify(all).length < 16384, `${JSON.stringify(all).length} bytes`);
  const d = door({ [HOME]: db });
  const run = await route(d, change(SHOP, 'table_10'));
  assert.equal(run.status, 'completed', run.error_message);
  assert.deepEqual(byKind(d, 'workflow-chosen-from-rows'), ['workflow:any-change']);
  const answers = d.calls.filter(call => call.name === 'tool:run-sql-in-my-database').length;
  assert.equal(answers, 3, 'two stores read, one definition read');
});

test('the read leaves out only what the formula engine would not keep: after fields, or groups, and rules it does not judge stay', async () => {
  const field = (id, kind, path = [id]) => ({ id, kind, path });
  const group = (combinator, rules, fieldsList) => ({ label: combinator, state: 'On', made_by: 'the person', condition: { fields: fieldsList, tree: { kind: 'group', combinator, negate: false, rules } } });
  const db = await store([
    ['workflow:design-ready', [group('and', [rule('place', 'is_any_of', ['product_stage']), rule('piece', 'is_any_of', ['design'])], [field('place', 'choice'), field('piece', 'choice', ['after', 'piece'])])], null],
    ['workflow:niche-or-kind', [group('or', [{ kind: 'rule', field: 'niches', operator: 'is_not_empty' }, rule('kinds', 'has_any_of', ['niche'])], [field('niches', 'tags'), field('kinds', 'tags')])], null],
    ['workflow:text-place', [group('and', [rule('place', 'is_any_of', ['elsewhere'])], [field('place', 'text')])], null],
    ['workflow:before-state', [group('and', [rule('was', 'is_any_of', ['open'])], [field('was', 'choice', ['before', 'state'])])], null],
    ['workflow:number-choice', [group('and', [rule('n', 'is_any_of', [1])], [field('n', 'choice', ['after', 'n'])])], null],
  ]);
  const kept = async (after, kinds = null) => (await db.query(READ, ['product_stage', 'changed', SHOP, kinds, HOME, after === null ? null : JSON.stringify(after)])).rows.map(row => row.id);
  assert.deepEqual(await kept({ piece: 'design', n: 1 }), ['workflow:before-state', 'workflow:design-ready', 'workflow:number-choice', 'workflow:text-place']);
  assert.deepEqual(await kept({ piece: 'price', n: 2 }), ['workflow:before-state', 'workflow:text-place'],
    'an after field that is not listed leaves the condition out; is_any_of on a text field, which the engine does not judge, and a rule on before stay');
  assert.deepEqual(await kept(null, JSON.stringify(['niche'])), ['workflow:before-state', 'workflow:niche-or-kind', 'workflow:text-place'], 'an or group stays while one of its rules can be met');
  for (const [recipe, rules, fieldsList] of [['workflow:text-place', [rule('place', 'is_any_of', ['elsewhere'])], [field('place', 'text')]], ['workflow:design-ready', [rule('piece', 'is_any_of', ['design'])], [field('piece', 'choice', ['after', 'piece'])]]]) {
    const engine = await chooseTheWorkflowsThatFire({ parts: [{ place: 'product_stage', change: 'changed', where: SHOP, after: { piece: 'price' } }], own: [{ id: recipe, value: { recipe, fires_when: [group('and', rules, fieldsList)] } }], installed: false });
    assert.equal(engine.chosen.length + engine.named.unfinished > 0, (await kept({ piece: 'price', n: 2 })).includes(recipe), `${recipe}: the read keeps what the chooser would choose or name`);
  }
});

test('the router keeps no facts while it is switched off, so a computer whose router is off never fills its owed facts', () => {
  assert.deepEqual(ROUTER.wakes.map(wake => [wake.id, wake.replay]), [['a-row-changed', { within_ms: 86400000 }]]);
});

