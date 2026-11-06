// Ported from old trillion test/handoff-reads-flat.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. The old test opened the retired PersonStore; here makeAgents (tools/shared-code
// src/agents.mjs) runs over this tool's agentRecordStore on the record engine over a counting SQLite handle, opened
// again before the measured calls as the store was, and the store's alarm is the agents' own upkeep (the reconciler and
// the own-AI wake step). Every assertion is the old one.
// test/handoff-reads-flat.test.mjs
//
// What taking work (POST /handoffs/take) and publishing an agent (POST /agents/publish) read must not grow with the
// agents, or with the handoffs open, taken, held and finished behind them. From the person's store on 2026-10-09
// (read_use, 00:00-06:00Z): take read about 900 statements on each of 1,633 calls, publish about 1,150 on each of 558.
// The person's AIs all sign in as one reader and each chat keeps a card, so one reader has hundreds of cards, each with
// a few jobs waiting for it. This seeds N and then 4N through the agents' own calls and fails when a
// call reads more as they grow; it counts what SQLite hands back (test/person-store-reads-for-tests.mjs) and the rows
// the call wrote. Publishing again for a chat is the one call that must write each job that chat has open (the time its
// silence window ends moves with it), so that call is judged by a bound on each of the chat's own jobs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentRecordStore } from '../agent-records.mjs';

// What each statement hands back, counted (old test/person-store-reads-for-tests.mjs countingHost), with optional stacks.
function countingHost() {
  const host = sqliteHost(':memory:');
  const reads = [];
  let traceReads = false;
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    const rows = cursor.toArray();
    let bytes = 0;
    for (const row of rows) for (const value of Object.values(row)) bytes += typeof value === 'string' ? value.length : (value?.byteLength ?? 8);
    reads.push({ query, params, rows: rows.length, bytes, ...(traceReads ? { stack: new Error().stack } : {}) });
    return cursor;
  } };
  return { host, sql, take: () => reads.splice(0), traceReads: enabled => { traceReads = Boolean(enabled); } };
}

// The agents a person's store opened over its records: makeAgents over agentRecordStore on the record engine, opened
// afresh from the saved database each time (as the old personStoreOver opened the PersonStore), so nothing read before
// is kept in memory. `alarm` is the agents' own upkeep the store's alarm ran: the reconciler and the own-AI wake step.
function personStoreOver(store) {
  const records = openRecords(store.sql, { transaction: store.host.transaction, hash: text => text });
  let saved = null;
  const agentStore = { ...agentRecordStore({ records, transaction: store.host.transaction }),
    savedInstructions: () => structuredClone(saved), putSavedInstructions: list => { saved = structuredClone(list); } };
  const agents = makeAgents({ store: agentStore });
  return { store: { eeaf: records }, agents: () => agents,
    alarm: async () => { agents.reconcile(); agentStore.scheduledWake.step(); } };
}

// Jobs waiting for each AI by name.
const PER = Number(process.env.HANDOFF_FLAT_PER) || 3;
const sleep = ms => new Promise(done => setTimeout(done, ms));

// Opt-in SQL diagnostics observe only the measured call, never fixture seeding.
// Keep repeated-query counts and bounded caller stacks without bound values.
function reportFlatReads({ size, name, reads, prefix }) {
  const groups = new Map();
  for (const { query, rows, bytes, stack } of reads) {
    const caller = typeof stack === 'string' ? stack.split('\n').slice(1, 9).map(line => line.slice(0, 240)) : [];
    const text = String(query).replace(/\s+/g, ' ').slice(0, 900);
    const key = JSON.stringify([text, caller]);
    const group = groups.get(key) ?? { query: text, stack: caller, statements: 0, rows: 0, bytes: 0 };
    group.statements += 1; group.rows += rows; group.bytes += bytes;
    groups.set(key, group);
  }
  const queries = [];
  let retainedChars = 0, omittedGroups = 0, omittedStatements = 0;
  for (const group of groups.values()) {
    const chars = JSON.stringify(group).length;
    if (queries.length >= 128 || retainedChars + chars > 48_000) {
      omittedGroups += 1; omittedStatements += group.statements;
    } else { queries.push(group); retainedChars += chars; }
  }
  console.log(prefix + ' ' + JSON.stringify({ size, name, statements: reads.length,
    rows: reads.reduce((sum, read) => sum + read.rows, 0), queries,
    omitted_groups: omittedGroups, omitted_statements: omittedStatements }));
}

// `agents` AIs (four in five sign in as the reader `reader-0`, as every chat of one person's does; each chat has its own
// source_id), each with a few jobs waiting for it by name; `open` jobs waiting for anyone (a third of them from a chat's
// source and five of them already past the time their asker stopped waiting); `history` jobs handed to an agent, taken
// and then half of them finished.
async function measured({ agents: count, open, history }) {
  const store = countingHost();
  let person = await personStoreOver(store, `handoff-reads-${count}-${open}-${history}`);
  let agents = person.agents();
  const ids = Array.from({ length: count }, (_, i) => `agent-${i}`);
  const readerOf = i => (i % 5 === 4 ? `reader-${i}` : 'reader-0');
  const sources = { kept: () => true, recent: () => [] };
  ids.forEach((agent_id, i) => agents.publish({ agent_id, name: `Agent ${i}`, description: `Does job ${i}`, takes_work: true, source_id: `chat-${i}`, capacity: { max_concurrent: 20 } }, { reader: readerOf(i), sources }));
  const waiting = [];
  for (let i = 0; i < count * PER; i += 1) waiting.push(agents.handOff({ request_key: `named-${i}`, job: `Named job ${i} ${'words '.repeat(40)}`, input: { n: i }, to_agent: ids[i % count] }).handoff.handoff_id);
  const openIds = [];
  let chatJobs = 0;
  for (let i = 0; i < open; i += 1) {
    // One in seven waits for the job before it (a workflow's next step), so the jobs that wait on others grow with the rest.
    openIds.push(agents.handOff({ request_key: `open-${i}`, job: `Open job ${i} ${'words '.repeat(40)}`, ...(i % 20 === 0 && i < 100 ? { take_within_seconds: 1 } : {}),
      ...(i % 7 === 3 ? { depends_on: [openIds[i - 1]] } : {}),
      input: { n: i, ...(i % 3 === 0 ? { arrived: { source_id: `chat-${i % count}`, from_person: true } } : {}) } }).handoff.handoff_id);
    if (i % 3 === 0 && i % count === 4) chatJobs += 1;
  }
  // One busy chat (the one agent-4 publishes for) that has a tenth as many open jobs as everything else put together, which
  // is what publishing again for it has to look at.
  for (let i = 0; i < open / 10; i += 1, chatJobs += 1) agents.handOff({ request_key: `hot-${i}`, job: `Chat job ${i} ${'words '.repeat(40)}`, input: { n: i, arrived: { source_id: 'chat-4', from_person: true } } });
  const held = [];
  for (let i = 0; i < history; i += 1) {
    const to_agent = ids[(i * 7) % count];
    const { handoff } = agents.handOff({ request_key: `history-${i}`, job: `Past job ${i}`, input: { n: i }, to_agent });
    held.push({ handoff_id: handoff.handoff_id, agent_id: to_agent, ...agents.take({ agent_id: to_agent, handoff_id: handoff.handoff_id }) });
  }
  held.filter((_, i) => i % 2 === 0).forEach(item => agents.finish({ handoff_id: item.handoff_id, agent_id: item.agent_id, generation: item.generation, result: 'done' }));
  await sleep(1200);
  // The store's own upkeep (indexes and facts it fills in a few at a time) settles before the calls under test.
  for (let wake = 0; wake < 3; wake += 1) await person.alarm();
  // A take gives a few open jobs the facts they are found by, until every one has them.
  agents.publish({ agent_id: 'idle', name: 'Idle', description: 'Takes nothing', takes_work: true }, { reader: 'reader-idle' });
  for (let ask = 0; ask < 40; ask += 1) agents.take({ agent_id: 'idle', only_mine: true }, { reader: 'reader-idle' });
  // The record store's own idle work (writing out the memtable, merging its runs, filling indexes) is run until none is
  // due, not for a fixed time: a range read probes every run, so a store left with four unmerged runs read 11 rows on a
  // take that reads 8 once they merge, and a publish under load read 13 (2026-10-16, limit 12.5). What is measured is a
  // store whose upkeep has caught up, as an account's is between bursts of work.
  const records = person.store.eeaf;
  for (let step = 0; records.maintenanceAt() !== null; step += 1) {
    assert.ok(step < 1000, `the record store's idle work settles (still due after ${step} steps)`);
    records.maintain({ max_pages: 64 });
  }
  // The store has been asleep since (a busy account's store is opened again from its saved pages for most calls), so nothing
  // read just now is kept in memory: each read below goes to SQLite.
  { person = await personStoreOver(store, `handoff-reads-${count}-${open}-${history}`); agents = person.agents(); }
  const costs = {};
  const cost = async (name, ask) => {
    store.take();
    const mode = process.env.HANDOFF_FLAT_DIAGNOSTICS;
    const diagnostic = (mode === '1' && name.startsWith('POST /handoffs/take'))
      || (mode === 'PUBLISH' && name.includes('publish'));
    store.traceReads(diagnostic);
    let answer;
    try { answer = await ask(); } finally { store.traceReads(false); }
    const reads = store.take();
    costs[name] = { statements: reads.length, rows: reads.reduce((sum, read) => sum + read.rows, 0), written: reads.filter(read => /^\s*(INSERT|UPDATE|DELETE)/.test(read.query)).length };
    if (diagnostic) reportFlatReads({ size: count, name, reads, prefix: mode === 'PUBLISH' ? 'PUBLISH_READS' : 'HANDOFF_READS' });
    return answer;
  };
  const taken = await cost('POST /handoffs/take', () => agents.take({ agent_id: ids[1] }, { reader: 'reader-0' }));
  const named = await cost('POST /handoffs/take (a job by name)', () => agents.take({ agent_id: ids[2], handoff_id: waiting[2] }, { reader: 'reader-0' }));
  await cost('POST /handoffs/take (nothing waiting)', () => agents.take({ agent_id: ids[3], only_mine: true }, { reader: 'reader-0' }));
  await cost('POST /agents/publish (a chat with many open jobs)', () => agents.publish({ agent_id: ids[4], name: 'Agent 4', description: 'Does job 4', takes_work: true, source_id: 'chat-4', capacity: { max_concurrent: 20 } }, { reader: readerOf(4), sources }));
  await cost('POST /agents/publish (no chat)', () => agents.publish({ agent_id: ids[0], name: 'Agent 0', description: 'Does job 0', takes_work: true, source_id: null, capacity: { max_concurrent: 5 } }, { reader: 'reader-0' }));
  await cost('POST /agents/publish (new agent)', () => agents.publish({ agent_id: 'newcomer', name: 'Newcomer', description: 'Does new things', takes_work: true }, { reader: 'reader-new' }));
  return { costs, taken, named, chatJobs };
}

test('taking work and publishing read the same with 4 times as many agents and handoffs', { timeout: 900000 }, async () => {
  const small = await measured({ agents: 10, open: 100, history: 60 });
  const large = await measured({ agents: 40, open: 400, history: 240 });
  const grown = [];
  for (const name of Object.keys(small.costs)) {
    console.log(`${name}: ${JSON.stringify(small.costs[name])} -> ${JSON.stringify(large.costs[name])}`);
    // Statements, rows read and rows written per call.
    for (const key of ['statements', 'rows', 'written']) {
      if (name.includes('many open jobs')) continue;
      if (large.costs[name][key] > 1.5 * small.costs[name][key] + 8) grown.push(`${name} ${key}: ${small.costs[name][key]} -> ${large.costs[name][key]}`);
      if (large.costs[name][key] > 80) grown.push(`${name} ${key} is ${large.costs[name][key]}, over the ceiling of 80`);
    }
  }
  // Publishing again for a chat writes each job the chat has open and reads it once, and nothing else grows with it.
  for (const { costs, chatJobs } of [small, large]) {
    const busy = costs['POST /agents/publish (a chat with many open jobs)'];
    if (busy.statements > 40 + 4 * chatJobs) grown.push(`publishing for a chat with ${chatJobs} open jobs took ${busy.statements} statements`);
    if (busy.rows > 20 + 2 * chatJobs) grown.push(`publishing for a chat with ${chatJobs} open jobs read ${busy.rows} rows`);
    if (busy.written > 10) grown.push(`publishing for a chat with ${chatJobs} open jobs wrote ${busy.written} rows (the jobs are written together)`);
  }
  assert.deepEqual(grown, [], 'a call read more as the agents and handoffs behind it grew');
  assert.ok(small.taken.handoff && large.taken.handoff, 'the agent still takes work');
});
