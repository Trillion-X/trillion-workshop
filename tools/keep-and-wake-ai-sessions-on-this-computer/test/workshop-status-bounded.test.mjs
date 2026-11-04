import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { addWorkshopFact, workshopValues, workshopValuesPage } from '../../shared-code/src/workshop-facts.mjs';
import { httpJson, makeWorkshop, readToolData } from '../src/workshop.mjs';

const placement = { kind: 'tool-placement', id: 'placement:hosted', label: 'Hosted', executor: 'http', reachable_from: ['hosted'] };
const licence = { kind: 'tool-licence-class', id: 'licence:open', label: 'Open', licences: ['MIT'], allowed_placements: [placement.id] };
const descriptor = (id, invoke = { kind: 'model', model: 'answer', input: {} }) => ({
  kind: 'ai-tool-descriptor', id, label: id, job: 'Answer a question', status: 'active',
  input_schema: { type: 'object' }, output_schema: { type: 'object', required: ['text'] },
  invoke, licence_class: licence.id, placements: [placement.id],
});
const connector = descriptor('tool:connect-own-service', { kind: 'held-values', operation: 'connect', provider: 'own-service', connects: {
  connection: 'own-service', credential_fields: [{ id: 'api_key', secret: true }], verify_request: { method: 'GET', url: 'https://own.example/me' },
} });
const use = descriptor('tool:read-own-service', { kind: 'http-request', method: 'GET', url: 'https://own.example/value',
  connection: 'own-service', connection_id: 'service_connection:own-service',
  credential_injections: [{ field_id: 'api_key', placement: { kind: 'header', name: 'Authorization' } }],
});
const started = '2026-10-01T00:00:00.000Z';

// The production saved-tool readers over the production facts/index owner. Catalog reads are counted after
// seeding and warming its legacy-fill marker, so catalog growth is real SQLite work rather than an array mock.
function host(t, count, { state = 'working', observed = 'running', space = false, authorizeSpaceTask = async () => {}, executor = httpJson, tool = use, shared = [], catalogUnavailable = false, cleanupError = false } = {}) {
  const database = sqliteHost(':memory:');
  t.after(() => database.db.close());
  const queries = [];
  const sql = { exec(query, ...values) {
    const result = database.sql.exec(query, ...values);
    queries.push({ query, rows: result.toArray().length });
    return result;
  } };
  sql.exec('CREATE TABLE workshop_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity TEXT NOT NULL, value TEXT NOT NULL)');
  sql.exec('CREATE INDEX workshop_facts_current ON workshop_facts (entity, seq)');
  for (let index = 0; index < count; index += 1) {
    const row = descriptor(`tool:unrelated-${String(index).padStart(5, '0')}`);
    addWorkshopFact(sql, `tool:${row.id}`, row, started);
  }
  for (const row of [connector, tool]) addWorkshopFact(sql, `tool:${row.id}`, row, started);
  workshopValuesPage(sql, 'tool:', { limit: 1 });
  const task = { task_id: 'task:held-run', tool_id: tool.id, placement: placement.id, placement_label: placement.label,
    state, started_at: started, input: {}, history: [],
    ...(state === 'completed' ? { output: { text: 'private result' }, contract: { passed: true } } : {}),
    ...(space ? { space_authorization: { space_id: 'space:one', grant_id: 'grant:one', tool_version: 'version:one' } } : {}),
  };
  const tasks = new Map([[task.task_id, task]]);
  const events = { observed: 0, cleaned: 0, sent: 0, data: 0, catalog: 0, connectionChecks: 0 };
  const run = Object.assign(async args => executor(args), {
    resumes: true,
    observe: async (_task, place) => { assert.equal(place.id, placement.id); events.observed += 1; return { state: observed }; },
    cleanup: async (_task, place) => {
      assert.equal(place.id, placement.id); events.cleaned += 1;
      if (cleanupError) throw new Error('executor cleanup unavailable');
    },
  });
  const readValue = entity => {
    const row = sql.exec('SELECT value FROM workshop_facts WHERE entity = ? ORDER BY seq DESC LIMIT 1', entity).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  };
  const workshop = makeWorkshop({
    host: 'hosted', now: () => new Date('2026-10-02T00:00:00Z'),
    data: async () => { events.data += 1; return readToolData([placement, licence, ...shared].map(payload => ({ payload }))); },
    authorizeSpaceTask,
    connections: async () => { events.connectionChecks += 1; return []; },
    store: {
      readTask: async id => tasks.get(id) ?? null,
      writeTask: async value => { tasks.set(value.task_id, value); },
      readEffect: async () => null,
      readSavedTool: async id => {
        events.catalog += 1;
        if (catalogUnavailable) throw new Error('tool definition unavailable');
        return readValue(`tool:${id}`);
      },
      readSavedTools: async () => { events.catalog += 1; return workshopValues(sql, 'tool:'); },
      savedToolsPage: async ({ after, limit }) => {
        events.catalog += 1;
        const page = workshopValuesPage(sql, 'tool:', { after, limit });
        return { rows: page.rows.map(row => row.value), next: page.next };
      },
    },
    box: { check_exists: async () => true, send: async () => { events.sent += 1; return { status_code: 200, body: '{"text":"done"}' }; } },
    executors: { http: run },
    pool: { recordRun: async () => {}, recordReport: async () => {}, stats: async () => ({}) },
  });
  queries.length = 0;
  return { workshop, tasks, task, events, queries, sql };
}

for (const count of [400, 1600]) {
  for (const state of ['working', 'completed']) {
    test(`${state} task read does not load a ${count}-tool saved catalog`, async t => {
      const fixture = host(t, count, { state });
      const result = await fixture.workshop.read({ task_id: fixture.task.task_id });
      assert.equal(result.state, state);
      assert.equal(fixture.events.observed, state === 'working' ? 1 : 0);
      assert.equal(fixture.events.cleaned, state === 'completed' ? 1 : 0);
      assert.equal(fixture.events.sent, 0, 'observing and cleaning never dispatch');
      const cost = { count, state, statements: fixture.queries.length, rows: fixture.queries.reduce((n, row) => n + row.rows, 0), catalog_calls: fixture.events.catalog };
      t.diagnostic(JSON.stringify(cost));
      assert.equal(cost.catalog_calls, 0, 'a stored placement needs shared DATA, never tool credentials or catalog discovery');
      assert.equal(cost.statements, 0);
    });
  }
}

test('completed Space cleanup runs before current read authorization, and revocation hides the output', async t => {
  const checks = [];
  const fixture = host(t, 400, { state: 'completed', space: true, authorizeSpaceTask: async (grant, tool, operation) => {
    checks.push({ grant, tool, operation });
    throw new Error('This Space tool grant is revoked.');
  } });
  const error = await fixture.workshop.read({ task_id: fixture.task.task_id }).catch(error => error);
  assert.match(error.message, /grant is revoked/);
  assert.equal('output' in error, false);
  assert.equal(fixture.events.cleaned, 1);
  assert.equal(fixture.tasks.get(fixture.task.task_id).state, 'completed');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].operation, 'read');
  assert.equal(checks[0].tool.id, use.id, 'current tool definition still reaches the Space owner');
  assert.ok(fixture.events.catalog > 0, 'Space tool/version authorization retains its full definition path');
});

test('terminal cleanup does not depend on the tool definition remaining readable', async t => {
  const fixture = host(t, 400, { state: 'completed', catalogUnavailable: true });
  assert.equal((await fixture.workshop.read({ task_id: fixture.task.task_id })).state, 'completed');
  assert.equal(fixture.events.cleaned, 1);
  assert.equal(fixture.events.catalog, 0);
});

test('cleanup failure preserves the authoritative completed result', async t => {
  const fixture = host(t, 400, { state: 'completed', cleanupError: true });
  const result = await fixture.workshop.read({ task_id: fixture.task.task_id });
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.output, { text: 'private result' });
  assert.equal(fixture.events.cleaned, 1);
  assert.equal(fixture.tasks.get(fixture.task.task_id).state, 'completed');
});

test('revoked working Space authorization prevents observing or resuming its executor', async t => {
  const fixture = host(t, 400, { space: true, authorizeSpaceTask: async () => { throw new Error('This Space tool grant is revoked.'); } });
  const result = await fixture.workshop.read({ task_id: fixture.task.task_id });
  assert.equal(result.state, 'failed');
  assert.equal('output' in result, false);
  assert.equal(fixture.events.cleaned, 1);
  assert.equal(fixture.events.observed, 0);
  assert.equal(fixture.events.sent, 0);
});

test('observing and cleaning use the same last duplicate placement as execution', async () => {
  const last = { ...placement, executor: 'last-executor', binding: 'last' };
  const data = readToolData([placement, last, licence].map(payload => ({ payload })));
  assert.equal(data.placements.length, 2, 'the shared DATA decoder currently retains both declarations');
  const expected = new Map(data.placements.map(place => [place.id, place])).get(placement.id);
  const calls = [];
  const task = { task_id: 'duplicate-placement', tool_id: use.id, placement: placement.id, state: 'working', started_at: started };
  const executor = Object.assign(async () => { throw new Error('observation cannot dispatch'); }, {
    resumes: true,
    observe: async (_task, place) => { calls.push(['observe', place]); return { state: 'running' }; },
    cleanup: async (_task, place) => { calls.push(['cleanup', place]); },
  });
  const workshop = makeWorkshop({
    host: 'hosted', data: async () => data, store: { readTask: async () => task },
    executors: { http: () => { throw new Error('first duplicate cannot run'); }, 'last-executor': executor },
  });
  assert.equal((await workshop.read({ task_id: task.task_id })).state, 'working');
  task.state = 'completed';
  assert.equal((await workshop.read({ task_id: task.task_id })).state, 'completed');
  assert.deepEqual(calls, [['observe', expected], ['cleanup', expected]]);
});

test('a lost run resolves its saved connector grant again before resuming', async t => {
  const fixture = host(t, 400, { observed: 'none' });
  await fixture.workshop.read({ task_id: fixture.task.task_id });
  // The zero-wait resume may finish after read returns; waiting on the same task is bounded and never starts a second run.
  for (let attempt = 0; attempt < 30 && fixture.tasks.get(fixture.task.task_id).state === 'working'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const done = fixture.tasks.get(fixture.task.task_id);
  assert.equal(done.state, 'completed', done.error);
  assert.deepEqual(done.output, { text: 'done' });
  assert.equal(done.taken_up, 1);
  assert.equal(fixture.events.sent, 1);
  assert.ok(fixture.events.catalog > 1, 'actual execution still reads the saved connector grant');
});

test('resume refuses a saved tool destination outside its shared connector grant', async t => {
  const fixture = host(t, 400, { observed: 'none', shared: [connector, { ...use, id: 'tool:shared-allowed-use' }], tool: { ...use, invoke: { ...use.invoke, url: 'https://elsewhere.example/value' } } });
  await fixture.workshop.read({ task_id: fixture.task.task_id });
  for (let attempt = 0; attempt < 30 && fixture.tasks.get(fixture.task.task_id).state === 'working'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(fixture.tasks.get(fixture.task.task_id).state, 'failed');
  assert.match(fixture.tasks.get(fixture.task.task_id).error, /may only be sent to own.example/);
  assert.equal(fixture.events.sent, 0);
});

test('resume refuses a source connection whose current incarnation changed', async t => {
  const tool = { ...use, invoke: { ...use.invoke, source_connection: { connection_id: use.invoke.connection_id, connected_at: started } } };
  const fixture = host(t, 400, { observed: 'none', tool });
  await fixture.workshop.read({ task_id: fixture.task.task_id });
  for (let attempt = 0; attempt < 30 && fixture.tasks.get(fixture.task.task_id).state === 'working'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(fixture.tasks.get(fixture.task.task_id).state, 'failed');
  assert.match(fixture.tasks.get(fixture.task.task_id).error, /source connection is disconnected or changed/);
  assert.equal(fixture.events.connectionChecks, 1);
  assert.equal(fixture.events.sent, 0);
});
