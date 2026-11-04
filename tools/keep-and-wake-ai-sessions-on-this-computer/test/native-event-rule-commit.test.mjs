import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventRules } from '../src/events.mjs';
import { sqliteHost } from '../src/local-store.mjs';

const source = { id: 'events:fixture', label: 'Fixture source', events: [{ name: 'message', fields: { text: ['text'] } }] };
const input = { rule_id: 'rule-fixture', source_id: source.id, event: 'message', then: { tool_id: 'tool:fixture', input: {} }, label: 'Original rule' };
const at = '2026-10-15T05:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, { native = true, commitRule, beforeRead = async () => {}, beforeList = async () => {}, beforeSources = async () => {}, beforeDescribe = async () => {} } = {}) {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  host.sql.exec('CREATE TABLE event_facts (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  host.sql.exec('CREATE TABLE command_results (request_key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const trace = [], commits = [];
  let admitted = true, failAfterWrite = false, key = 'original-command';
  const read = name => { const row = host.sql.exec('SELECT value FROM event_facts WHERE key=?', name).toArray()[0]; return row ? JSON.parse(row.value) : null; };
  const write = (name, value) => host.sql.exec('INSERT INTO event_facts VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', name, JSON.stringify(value));
  const facts = {
    read: async name => { trace.push(`read:${name}`); await beforeRead(name); return read(name); },
    list: async prefix => { trace.push(`list:${prefix}`); await beforeList(prefix); return host.sql.exec('SELECT value FROM event_facts WHERE key LIKE ? ORDER BY key', `${prefix}%`).toArray().map(row => JSON.parse(row.value)); },
    write: async (name, value) => { trace.push(`legacy-write:${name}`); write(name, value); },
  };
  const rules = makeEventRules({ facts, routes: {}, workshop: {},
    sources: async () => { trace.push('sources'); await beforeSources(); return [source]; },
    workflows: { recipeOf: async () => { trace.push('workflow'); await beforeDescribe(); } },
    now: () => new Date(at),
    beforeRuleMutation: async (operation, mutation) => {
      trace.push(`gate:${operation}`);
      assert.ok(mutation.key.startsWith('event-rule:'));
      if (!admitted) throw Object.assign(new Error('Current rule rights were revoked.'), { status: 403 });
    },
    ...(native ? { commitRule: commitRule ?? (mutation => host.transaction(() => {
      assert.ok(trace.at(-1).startsWith('gate:') || trace.at(-1) === 'transform', 'No awaited owner read follows the final admission.');
      if (!admitted) throw Object.assign(new Error('Current synchronous commitment was revoked.'), { status: 403 });
      write(mutation.key, mutation.value);
      if (failAfterWrite) throw new Error('The original transaction did not commit.');
      host.sql.exec('INSERT INTO command_results VALUES(?,?)', key, JSON.stringify(mutation.result));
      trace.push(`commit:${mutation.operation}`); commits.push(structuredClone(mutation));
      return mutation.result;
    })) } : {}),
  });
  return { rules, trace, commits, read, write, revoke: () => { admitted = false; },
    request: value => { key = value; }, failCommit: () => { failAfterWrite = true; },
    result: () => { const row = host.sql.exec('SELECT value FROM command_results WHERE request_key=?', key).toArray()[0]; return row ? JSON.parse(row.value) : null; } };
}

test('canonical event set reads listener before final admission and captures the formatted result with its native fact', async t => {
  const f = fixture(t);
  f.write(`event-listen:${source.id}`, { source_id: source.id, stopped: false });
  const answer = await f.rules.set(input, { transform: result => { f.trace.push('transform'); return { rule: result, next_call: { tool: 'list_rules', arguments: {} } }; } });
  assert.deepEqual(f.result(), answer);
  assert.equal(f.read('event-rule:rule-fixture').label, 'Original rule');
  assert.equal(answer.rule.listening, true);
  assert.deepEqual(answer.rule.event_fields, ['text']);
  assert.deepEqual(f.trace, ['sources', 'list:event-rule:', `read:event-listen:${source.id}`, 'gate:rules:set', 'transform', 'commit:rules:set']);
  assert.equal(f.commits[0].operation, 'rules:set');
  assert.equal(f.commits[0].key, 'event-rule:rule-fixture');
});

for (const delayed of ['source', 'workflow', 'listener']) {
  test(`event set rechecks current rights after delayed ${delayed} read and writes nothing on revocation`, async t => {
    const arrived = deferred(), release = deferred();
    const wait = async () => { arrived.resolve(); await release.promise; };
    const f = fixture(t, {
      beforeSources: delayed === 'source' ? wait : undefined,
      beforeDescribe: delayed === 'workflow' ? wait : undefined,
      beforeRead: delayed === 'listener' ? async name => { if (name.startsWith('event-listen:')) await wait(); } : undefined,
    });
    const pending = f.rules.set(delayed === 'workflow' ? { ...input, then: { workflow_id: 'workflow:fixture', input: {} } } : input);
    await arrived.promise; f.revoke(); release.resolve();
    await assert.rejects(pending, { status: 403 });
    assert.equal(f.read('event-rule:rule-fixture'), null);
    assert.equal(f.result(), null);
    assert.deepEqual(f.commits, []);
    assert.equal(f.trace.at(-1), 'gate:rules:set');
  });
}

for (const verb of ['turn', 'remove']) {
  test(`canonical event ${verb} captures its transformed native result without later owner reads`, async t => {
    const f = fixture(t);
    await f.rules.set(input); f.request(`original-${verb}`); f.trace.length = 0;
    const answer = await f.rules[verb]({ rule_id: input.rule_id, enabled: false }, { transform: result => ({ answer: result }) });
    assert.deepEqual(f.result(), answer);
    assert.deepEqual(f.trace, ['list:event-rule:', `gate:${verb === 'turn' ? 'rules:set' : 'rules:remove'}`, `commit:${verb === 'turn' ? 'rules:set' : 'rules:remove'}`]);
    assert.equal(verb === 'turn' ? f.read(`event-rule:${input.rule_id}`).enabled : f.read(`event-rule:${input.rule_id}`).removed, verb !== 'turn');
    assert.equal(answer.answer.rule_id, input.rule_id);
  });

  test(`canonical event ${verb} cannot mutate after current-rule lookup is delayed past revocation`, async t => {
    const arrived = deferred(), release = deferred();
    let delay = false;
    const f = fixture(t, { beforeList: async () => { if (delay) { arrived.resolve(); await release.promise; } } });
    await f.rules.set(input); f.request(`original-${verb}`); delay = true;
    const earlier = f.read(`event-rule:${input.rule_id}`);
    const pending = f.rules[verb]({ rule_id: input.rule_id, enabled: false });
    await arrived.promise; f.revoke(); release.resolve();
    await assert.rejects(pending, { status: 403 });
    assert.deepEqual(f.read(`event-rule:${input.rule_id}`), earlier);
    assert.equal(f.result(), null);
    assert.equal(f.commits.length, 1, 'Only the earlier set committed.');
  });
}

test('failed synchronous event commitment rolls back both fact and exact-result capture', async t => {
  const f = fixture(t); f.failCommit();
  await assert.rejects(f.rules.set(input), /original transaction did not commit/);
  assert.equal(f.read(`event-rule:${input.rule_id}`), null);
  assert.equal(f.result(), null);
  assert.deepEqual(f.commits, []);
});

test('a throwing high-level event result transform never starts the native mutation', async t => {
  const f = fixture(t);
  await assert.rejects(f.rules.set(input, { transform: () => { throw new Error('Formatting refused before commit.'); } }), /Formatting refused/);
  assert.equal(f.read(`event-rule:${input.rule_id}`), null);
  assert.equal(f.result(), null);
  assert.deepEqual(f.commits, []);
});

test('a declared async native event commit is refused before it can start', () => {
  let started = false;
  assert.throws(() => makeEventRules({ facts: {}, routes: {}, workshop: {}, sources: async () => [source],
    commitRule: async () => { started = true; } }), /must be synchronous/);
  assert.equal(started, false);
});

test('a returned native commit Promise is refused and never falls back to asynchronous fact writes', async t => {
  const f = fixture(t, { commitRule: mutation => Promise.resolve(mutation.result) });
  await assert.rejects(f.rules.set(input), /must be synchronous/);
  assert.equal(f.read(`event-rule:${input.rule_id}`), null);
  assert.equal(f.result(), null);
  assert.equal(f.trace.some(row => row.startsWith('legacy-write:')), false);
});

test('an async high-level event result transform is refused before native commitment', async t => {
  const f = fixture(t);
  await assert.rejects(f.rules.set(input, { transform: async result => ({ rule: result }) }), /must be synchronous/);
  assert.equal(f.read(`event-rule:${input.rule_id}`), null);
  assert.equal(f.result(), null);
  assert.deepEqual(f.commits, []);
});

test('legacy async event facts retain the same untransformed and transformed responses', async t => {
  const f = fixture(t, { native: false });
  const saved = await f.rules.set(input);
  assert.equal(saved.rule_id, input.rule_id);
  assert.equal(saved.listening, false);
  assert.deepEqual(saved.next_call, { tool: 'listen_for_events', arguments: { source_id: source.id } });
  const turned = await f.rules.turn({ rule_id: input.rule_id, enabled: false }, { transform: result => ({ rule: result }) });
  assert.equal(turned.rule.enabled, false);
  assert.deepEqual(await f.rules.remove({ rule_id: input.rule_id }), { rule_id: input.rule_id, removed: true });
  assert.equal(f.result(), null);
  assert.equal(f.trace.filter(item => item.startsWith('legacy-write:')).length, 3);
  assert.deepEqual(f.commits, []);
});
