import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOpenWorkPage } from '../../hand-work-to-ais/agent-open-work-page.mjs';
import { anyoneFrom } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { agentLegacyRows } from '../../hand-work-to-ais/agent-legacy-rows.mjs';

test('projected helper pages preserve unmoved legacy cursors, record shadows and dependency answers', () => {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const current = agentRecordStore({ records, transaction: host.transaction });
  const expected = agentStoreForTests();
  host.sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  for (let n = 0; n < 7; n++) {
    const item = { handoff_id: `h${n}`, state: n === 6 ? 'finished' : 'open', handed_at: '2026-10-12T00:00:00Z',
      job: 'words '.repeat(2048), result: { answer: 'answer '.repeat(2048) },
      input: { arrived: { source_id: 'codex:one', from_person: true, chat_first_minutes: 5 } },
      depends_on: n % 2 ? ['h6'] : ['absent-parent'] };
    expected.putHandoff(item);
    if (n % 2) current.putHandoff(item);
    else host.sql.exec('INSERT INTO agent_handoffs VALUES (?, ?, NULL, ?, ?)', item.handoff_id, item.state === 'finished' ? 0 : 1, item.handed_at, JSON.stringify(item));
  }
  const closed = { ...expected.handoff('h2'), state: 'finished' };
  current.putHandoff(closed); expected.putHandoff(closed);
  const bridge = agentLegacyRows({ sql: host.sql, records, current });
  for (let after = null; ;) {
    const input = { after, limit: 2, agent_scope: 'work' };
    const page = agentOpenWorkPage(bridge, input);
    assert.deepEqual(page, agentOpenWorkPage(expected, input));
    if (!page.next_after) break;
    after = page.next_after;
  }
  assert.deepEqual(agentOpenWorkPage(bridge, { handoff_id: 'h4', agent_scope: 'work' }), agentOpenWorkPage(expected, { handoff_id: 'h4', agent_scope: 'work' }));
  assert.equal(bridge.handoff('h4').job, expected.handoff('h4').job, 'default legacy exact reads remain complete');
  host.db.close();
});

for (const engine of ['log', 'eeaf']) test(`open-work page projection avoids discarded job and answer hydration on ${engine}`, t => {
  const host = sqliteHost(':memory:');
  if (engine === 'eeaf') setRecordEngine(host.sql, engine);
  let records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const writer = agentRecordStore({ records, transaction: host.transaction });
  const expected = agentStoreForTests();
  const card = { agent_id: 'owner', takes_work: true, source_id: 'codex:one' };
  writer.putCard(card); expected.putCard(card);
  const parent = { handoff_id: 'finished-parent', handed_at: '2026-10-11T00:00:00Z', state: 'finished', job: 'parent '.repeat(2048), result: { answer: 'answer '.repeat(4096) } };
  writer.putHandoff(parent); expected.putHandoff(parent);
  const written = new Set(['agent-handoff:finished-parent']);
  for (let n = 0; n < 8; n++) {
    const item = { handoff_id: `h${n}`, handed_at: '2026-10-12T00:00:00Z', state: 'open',
      priority: n, preferred_agent: 'owner', from_agent: 'owner',
      job: 'instructions '.repeat(2048), result: { answer: 'answer '.repeat(4096) },
      corrections: [{ reason: 'history '.repeat(2048) }],
      input: { arrived: { source_id: 'codex:one', from_person: true, chat_silence_minutes: 9, body: 'source '.repeat(2048) } },
      source_active_at: '2026-10-12T00:03:00Z', depends_on: n % 4 === 1 ? ['finished-parent'] : n % 2 ? ['missing-parent'] : [] };
    writer.putHandoff(item); expected.putHandoff(item);
    written.add(`agent-handoff:h${n}`);
  }
  records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  let hydrated = [];
  const observe = key => { if (written.has(key)) hydrated.push(key); };
  const observed = { ...records,
    read: key => { observe(key); return records.read(key); },
    readMany: keys => { keys.forEach(observe); return records.readMany(keys); } };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  const input = { limit: 2, agent_scope: 'work' };
  const first = agentOpenWorkPage(store, input);
  assert.deepEqual(first, agentOpenWorkPage(expected, input), 'source timing, dependency state and referenced agents match the complete authoritative store');
  t.diagnostic(JSON.stringify({ engine, page: 'cold-first', fully_hydrated_handoffs: hydrated.length }));
  assert.equal(hydrated.length, 0, 'the metadata page must not hydrate complete handoff instructions, answers or correction history');
  hydrated = [];
  const cursor = first.next_after;
  writer.putHandoff({ ...writer.handoff(cursor), state: 'finished' });
  expected.putHandoff({ ...expected.handoff(cursor), state: 'finished' });
  const next = { ...input, after: cursor };
  assert.deepEqual(agentOpenWorkPage(store, next), agentOpenWorkPage(expected, next), 'a finished cursor retains the tied-time page boundary');
  assert.equal(hydrated.length, 0, 'cursor validation and dependent state reads stay projected too');
  hydrated = [];
  const named = { ...input, handoff_id: 'h6' };
  assert.deepEqual(agentOpenWorkPage(store, named), agentOpenWorkPage(expected, named));
  assert.equal(hydrated.length, 0, 'an exact helper read has the same metadata bound');
  assert.throws(() => agentOpenWorkPage(store, { ...input, after: 'absent' }), /no longer exists/);
  assert.equal(writer.handoff('h6').job.length, 'instructions '.repeat(2048).length, 'the ordinary complete read retains instructions');
  host.db.close();
});

for (const count of [128, 512]) test(`helper pages read only exact and source-owner cards with ${count} unrelated cards`, () => {
  const cards = [
    { agent_id: 'assigned', takes_work: true, source_id: null },
    { agent_id: 'owner', takes_work: true, source_id: 'codex:one' },
    ...Array.from({ length: count }, (_, i) => ({ agent_id: `unrelated-${i}`, takes_work: true, source_id: `codex:other-${i}` })),
  ];
  const jobs = [
    { handoff_id: 'a', state: 'open', handed_at: '2026-10-08T00:00:00Z', to_agent: 'assigned', input: { arrived: { source_id: 'codex:one' } } },
    { handoff_id: 'b', state: 'open', handed_at: '2026-10-08T00:01:00Z', input: { arrived: { source_id: 'codex:one' } } },
    { handoff_id: 'c', state: 'open', handed_at: '2026-10-08T00:02:00Z', input: { arrived: { source_id: 'codex:other-0' } } },
  ];
  let wholeReads = 0;
  const sourceReads = [];
  const exactReads = [];
  const store = {
    cardsById: ids => { exactReads.push(...ids); return ids.map(id => cards.find(card => card.agent_id === id)).filter(Boolean); },
    handoff: id => jobs.find(job => job.handoff_id === id),
    openHandoffs: ({ limit }) => jobs.slice(0, limit),
    cards: () => { wholeReads += 1; return cards; },
    cardsForSource: source => { sourceReads.push(source); return cards.filter(card => card.takes_work && card.source_id === source); },
  };
  const page = agentOpenWorkPage(store, { limit: 2, agent_scope: 'work' });
  assert.deepEqual(page.agents.map(card => card.agent_id).sort(), ['assigned', 'owner']);
  assert.equal(wholeReads, 0);
  assert.deepEqual(exactReads, ['assigned']);
  assert.deepEqual(sourceReads, ['codex:one'], 'one source lookup for repeated jobs, excluding the lookahead');
  assert.equal(page.next_after, 'b');
  assert.ok(JSON.stringify(page).length < 2000);
  const named = agentOpenWorkPage(store, { handoff_id: 'c', agent_scope: 'work', limit: 1 });
  assert.deepEqual(named.work.map(job => job.handoff_id), ['c']);
  assert.deepEqual(named.agents.map(card => card.agent_id), ['unrelated-0']);
  assert.equal(named.next_after, null);
  assert.equal(wholeReads, 0);
  assert.equal(agentOpenWorkPage(store, { limit: 2 }).agents.length, count + 2, 'old helpers keep their directory');
  assert.equal(wholeReads, 1);
  assert.throws(() => agentOpenWorkPage(store, { agent_scope: 'unknown' }), /scope/);
});

test('open work pages are bounded, ordered, and omit full message bodies', () => {
  const store = agentStoreForTests();
  store.putCard({ agent_id: 'chat', takes_work: true, source_id: 'codex:one', description: 'x'.repeat(100000) });
  for (let i = 0; i < 3; i++) {
    const handoff_id = `h${i}`;
    store.putHandoff({ handoff_id, state: 'open', handed_at: `2026-09-30T00:00:0${i}Z`, input: { arrived: { source_id: 'codex:one', from_person: true, body: 'x'.repeat(100000) } } });
  }
  const first = agentOpenWorkPage(store, { limit: 2 });
  assert.deepEqual(first.work.map(item => item.handoff_id), ['h0', 'h1']);
  assert.equal(first.next_after, 'h1');
  assert.equal(first.agents[0].source_id, 'codex:one');
  assert.equal(first.work[0].input.arrived.from_person, true);
  assert.ok(JSON.stringify(first).length < 2000);
  const second = agentOpenWorkPage(store, { after: first.next_after, limit: 2 });
  assert.deepEqual(second.work.map(item => item.handoff_id), ['h2']);
  assert.equal(second.next_after, null);
  store.putHandoff({ handoff_id: 'h2', state: 'open', handed_at: '2026-09-30T00:00:02Z', depends_on: ['missing-parent'] });
  assert.equal(agentOpenWorkPage(store, { after: 'h1' }).work[0].next_step.kind, 'dependency');
});

test('open work carries each job\'s priority, so the computer helper takes the person\'s own words first', () => {
  const store = agentStoreForTests();
  for (const [handoff_id, priority] of [['low', undefined], ['own', 5]]) {
    store.putHandoff({ handoff_id, state: 'open', handed_at: '2026-10-03T00:00:00Z', ...(priority === undefined ? {} : { priority }) });
  }
  const { work } = agentOpenWorkPage(store, {});
  assert.deepEqual(Object.fromEntries(work.map(item => [item.handoff_id, item.priority])), { low: 0, own: 5 });
});

test('every chat\'s job lists with the time any AI may take it, from the one owner, and a job whose time cannot be read never fails the page', () => {
  const store = agentStoreForTests();
  store.putHandoff({ handoff_id: 'a', state: 'open', handed_at: '2026-10-07T00:00:00Z', input: { arrived: { source_id: 'codex:one' } } });
  store.putHandoff({ handoff_id: 'b', state: 'open', handed_at: 'not a time', source_active_at: '2026-10-07T10:00:00Z', input: { arrived: { source_id: 'codex:two' } } });
  store.putHandoff({ handoff_id: 'c', state: 'open', handed_at: 'not a time', input: { arrived: { source_id: 'codex:three' } } });
  store.putHandoff({ handoff_id: 'd', state: 'open', handed_at: '2026-10-07T01:00:00Z' });
  const { work } = agentOpenWorkPage(store, {});
  const by = Object.fromEntries(work.map(item => [item.handoff_id, item]));
  assert.deepEqual(Object.keys(by).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(by.a.anyone_from, anyoneFrom({ handoff_id: 'a', handed_at: '2026-10-07T00:00:00Z', input: { arrived: { source_id: 'codex:one' } } }));
  assert.ok(Date.parse(by.a.anyone_from) > Date.parse('2026-10-07T00:00:00Z'));
  assert.equal(by.a.time_unreadable, undefined);
  assert.equal(by.b.time_unreadable, true);
  assert.ok(Date.parse(by.b.anyone_from) > Date.parse('2026-10-07T10:00:00Z'));
  assert.equal(by.c.time_unreadable, true);
  assert.equal(by.c.anyone_from, new Date(0).toISOString());
  assert.equal(by.d.anyone_from, undefined);
});
