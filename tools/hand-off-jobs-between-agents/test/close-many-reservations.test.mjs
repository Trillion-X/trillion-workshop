import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import { closeMany } from '../src/close-many.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const store = agentStoreForTests();
  const make = () => makeAgents({ store, now: () => new Date('2026-10-07T00:00:00Z') });
  const agents = make(), cases = new Map(), calls = [];
  agents.publish({ agent_id: 'runner', name: 'Runner', description: 'Runs jobs' });
  let count = 0;
  const job = extra => agents.handOff({ request_key: `closure:${++count}`, job: 'Requested work', input: { arrived: { message_id: `message:${count}`, from_person: true } }, ...extra }).handoff;
  const engine = {
    get: async id => { calls.push(['get', id]); return cases.get(id); },
    guide: async (id, answer) => { calls.push(['guide', id, answer]); return {}; },
    decideGuided: async (id, decision) => { calls.push(['decide', id]); cases.get(id).decision = decision; },
    recordCarriedOut: async (id, output) => { calls.push(['carried', id]); (cases.get(id).carried_out ??= []).push(output); },
  };
  const admit = async id => { calls.push(['admit', id]); const key = `case:${id}`; if (!cases.has(key)) cases.set(key, { source_id: id }); return key; };
  const input = (rows, outcome = 'handled') => ({ by: 'sorter', items: rows.map(row => ({ handoff_id: row.handoff_id, outcome, reason: 'The source shows this request was already handled.' })) });
  return { store, agents, make, job, engine, admit, calls, cases, input };
}

test('held, named, unresolved-effect and unfinished-child work produce no admission, decision, carried-out or digest effects', async () => {
  const f = fixture();
  const held = f.job(); f.agents.take({ handoff_id: held.handoff_id, agent_id: 'runner' });
  const named = f.job({ to_agent: 'runner' });
  const effect = f.job(); f.store.putHandoff({ ...f.store.handoff(effect.handoff_id), effects: { effect: { effect_id: 'effect', state: 'unknown' } } });
  const parent = f.job(); f.job({ parent_handoff_id: parent.handoff_id });
  const result = await closeMany(f, f.input([held, named, effect, parent], 'digest'));
  assert.equal(result.closed.length, 0); assert.equal(result.problems.length, 4); assert.equal(result.digest, null);
  assert.deepEqual(f.calls, []);
  for (const item of [held, named, effect, parent]) assert.equal(f.store.handoff(item.handoff_id).closing, undefined);
});

test('eligible completed-source work still records its decision and carried-out result once before closing', async () => {
  const f = fixture(), item = f.job(), input = f.input([item]);
  const done = await closeMany(f, input);
  assert.equal(done.closed.length, 1); assert.deepEqual(done.problems, []);
  const row = f.store.handoff(item.handoff_id);
  assert.equal(row.state, 'finished'); assert.equal(row.result.state, 'handled'); assert.equal(row.closing, undefined);
  assert.deepEqual(f.calls.filter(([kind]) => ['admit', 'decide', 'carried'].includes(kind)).map(([kind]) => kind), ['admit', 'decide', 'carried']);
  const calls = f.calls.length;
  assert.deepEqual((await closeMany(f, input)).repeated, [item.handoff_id]); assert.equal(f.calls.length, calls);
});

test('a reserved job cannot be taken, withdrawn or reconciled away while admission waits; duplicate attempts do not dispatch twice', async () => {
  const f = fixture(), item = f.job(), input = f.input([item]);
  let release;
  const inFlight = closeMany({ ...f, admit: async id => { await new Promise(resolve => { release = resolve; }); return f.admit(id); } }, input);
  await turn();
  const reserved = f.agents.read({ handoff_id: item.handoff_id }).handoff;
  assert.equal(reserved.state, 'open'); assert.equal(reserved.next_step.kind, 'blocked');
  assert.equal(f.agents.take({ handoff_id: item.handoff_id, agent_id: 'runner' }).handoff, null);
  assert.throws(() => f.agents.withdrawWaiting({ handoff_id: item.handoff_id, revision: reserved.revision, reason: 'Competing withdrawal' }, { person: true }), /reserved closure/);
  f.agents.reconcile({ handoff_id: item.handoff_id });
  assert.ok(f.store.handoff(item.handoff_id).closing);
  assert.match((await closeMany(f, input)).problems[0].problem, /already running/); assert.deepEqual(f.calls, []);
  release(); assert.equal((await inFlight).closed.length, 1);
});

test('restart resumes the same intent with a new generation and fences a superseded admission before any decision', async () => {
  const f = fixture(), item = f.job(), input = f.input([item]);
  let release;
  const old = closeMany({ ...f, admit: async id => { await new Promise(resolve => { release = resolve; }); return f.admit(id); } }, input);
  await turn(); const oldGeneration = f.store.handoff(item.handoff_id).generation;
  const restarted = f.make();
  const done = await closeMany({ ...f, agents: restarted }, input);
  assert.equal(done.closed.length, 1); assert.ok(f.store.handoff(item.handoff_id).generation > oldGeneration);
  const before = f.calls.filter(([kind]) => kind !== 'admit').length;
  release(); const ended = await old;
  assert.equal(ended.closed.length, 0); assert.match(ended.problems[0].problem, /no longer current/);
  assert.equal(f.calls.filter(([kind]) => kind !== 'admit').length, before);
  assert.equal(f.calls.filter(([kind]) => kind === 'decide').length, 1);
});

test('failure keeps the exact intent and digest for restart; changing intent is refused and retry creates no second digest', async () => {
  const f = fixture(), item = f.job(), input = f.input([item], 'digest');
  const first = await closeMany({ ...f, admit: async () => { throw Error('store reset before admission'); } }, input);
  assert.equal(first.closed.length, 0); assert.equal(first.problems[0].retry, true); assert.ok(first.digest.into);
  const before = f.store.handoff(item.handoff_id);
  assert.ok(before.closing); assert.equal(before.closing.digest_handoff_id, first.digest.into);
  const visible = f.agents.read({ handoff_id: item.handoff_id }).handoff;
  assert.equal(visible.closure.retry.path, '/handoffs/close-many');
  assert.equal(visible.closure.retry.body.items[0].reason, input.items[0].reason);
  assert.equal(visible.closure.reservation_token, undefined);
  const restarted = f.make();
  const changed = await closeMany({ ...f, agents: restarted }, { ...input, items: [{ ...input.items[0], reason: 'Changed justification' }] });
  assert.match(changed.problems[0].problem, /different closure intent/); assert.equal(f.calls.length, 0);
  const done = await closeMany({ ...f, agents: restarted }, input);
  assert.equal(done.closed.length, 1); assert.equal(done.digest.into, first.digest.into);
  assert.equal(f.store.handoff(item.handoff_id).result.into, first.digest.into);
});

test('a stale revision cannot reserve or close work after it changed', () => {
  const f = fixture(), item = f.job();
  f.store.putHandoff({ ...f.store.handoff(item.handoff_id), revision: item.revision + 1 });
  assert.throws(() => f.agents.reserveCloseWaiting({ handoff_id: item.handoff_id, revision: item.revision, by: 'sorter', intent: { outcome: 'handled' } }), /changed since/);
  assert.equal(f.store.handoff(item.handoff_id).closing, undefined);
});

test('shared admission excludes refused jobs and protects every included member across the async decision', async () => {
  const f = fixture(), allowed = [f.job(), f.job()], held = f.job();
  f.agents.take({ handoff_id: held.handoff_id, agent_id: 'runner' });
  const grouped = [];
  const admitTogether = async ids => {
    grouped.push(ids); const id = 'case:group'; f.cases.set(id, {});
    return { placed: new Map(ids.map(message => [message, id])), together: id, joined: ids };
  };
  const done = await closeMany({ ...f, admitTogether }, f.input([...allowed, held]));
  assert.deepEqual(grouped[0], allowed.map(item => item.input.arrived.message_id));
  assert.equal(done.closed.length, 2); assert.equal(done.problems.length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'decide').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'carried').length, 1);
});

test('shared admission failure retains reservations and never falls through into individual collateral decisions', async () => {
  const f = fixture(), items = [f.job(), f.job()];
  const done = await closeMany({ ...f, admitTogether: async () => { throw Error('shared decision refused'); } }, f.input(items));
  assert.equal(done.closed.length, 0); assert.equal(done.problems.length, 2); assert.deepEqual(f.calls, []);
  for (const item of items) assert.equal(f.store.handoff(item.handoff_id).state, 'open');
});

for (const failure of ['before receipt', 'after receipt']) test(`restart resumes the exact prepared decision ${failure} without repeating decision or receipt`, async () => {
  const f = fixture(), item = f.job(), input = f.input([item]);
  const engine = { ...f.engine, recordCarriedOut: async (...args) => {
    if (failure === 'after receipt') await f.engine.recordCarriedOut(...args);
    throw Error('carrier reset at receipt boundary');
  } };
  const failed = await closeMany({ ...f, engine }, input);
  assert.equal(failed.closed.length, 0); assert.equal(failed.problems.length, 1);
  assert.ok(f.store.handoff(item.handoff_id).closing.source_decision);
  assert.equal(f.store.handoff(item.handoff_id).state, 'open');
  const done = await closeMany({ ...f, agents: f.make() }, input);
  assert.equal(done.closed.length, 1); assert.deepEqual(done.problems, []);
  assert.equal(f.calls.filter(([kind]) => kind === 'decide').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'carried').length, 1);
});

test('a prepared closure never carries out a different source decision after restart', async () => {
  const f = fixture(), item = f.job(), input = f.input([item]);
  await closeMany({ ...f, engine: { ...f.engine, recordCarriedOut: async () => { throw Error('offline'); } } }, input);
  const id = f.store.handoff(item.handoff_id).closing.source_decision.case_id;
  f.cases.get(id).decision = { option_id: 'act', reason: 'A later authoritative change' };
  const done = await closeMany({ ...f, agents: f.make() }, input);
  assert.equal(done.closed.length, 0); assert.match(done.problems[0].problem, /decision changed/);
  assert.equal(f.calls.filter(([kind]) => kind === 'carried').length, 0);
});

test('an identical decision at a newer generation cannot inherit an older closure receipt', async () => {
  const f = fixture(), item = f.job(), input = f.input([item]);
  await closeMany({ ...f, engine: { ...f.engine, recordCarriedOut: async () => { throw Error('offline'); } } }, input);
  const prepared = f.store.handoff(item.handoff_id).closing.source_decision;
  f.cases.get(prepared.case_id).decision_generation = 2;
  const done = await closeMany({ ...f, agents: f.make() }, input);
  assert.equal(done.closed.length, 0); assert.match(done.problems[0].problem, /decision changed/);
  assert.equal(prepared.decision_generation, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'carried').length, 0);
  assert.equal(f.store.handoff(item.handoff_id).state, 'open');
});

test('grouped admission persisted before refusal is recovered through its original placements, without treating it as an unrelated follow-up', async () => {
  const f = fixture(), rows = [f.job(), f.job()], input = f.input(rows);
  let admitted = false;
  const admitTogether = async (ids, options) => {
    const case_id = 'case:group-restart';
    if (!admitted) {
      admitted = true; f.cases.set(case_id, { source_id: options.source_id });
      throw Error('links persisted but reply lost');
    }
    return { placed: new Map(ids.map(id => [id, case_id])), together: null, joined: [] };
  };
  assert.equal((await closeMany({ ...f, admitTogether }, input)).closed.length, 0);
  const partial = await closeMany({ ...f, agents: f.make(), admitTogether }, { ...input, items: input.items.slice(0, 1) });
  assert.equal(partial.closed.length, 0); assert.match(partial.problems[0].problem, /original grouped/);
  const done = await closeMany({ ...f, agents: f.make(), admitTogether }, { ...input, items: [...input.items].reverse() });
  assert.equal(done.closed.length, 2); assert.deepEqual(done.problems, []);
  assert.equal(f.calls.filter(([kind]) => kind === 'decide').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'carried').length, 1);
});

test('grouped carried-out refusal resumes the same prepared decision once after restart', async () => {
  const f = fixture(), rows = [f.job(), f.job()], input = f.input(rows);
  const admitTogether = async (ids, options) => {
    const id = 'case:group-receipt'; f.cases.set(id, { source_id: options.source_id });
    return { placed: new Map(ids.map(message => [message, id])), together: id, joined: ids };
  };
  const failed = await closeMany({ ...f, admitTogether, engine: { ...f.engine, recordCarriedOut: async () => { throw Error('offline'); } } }, input);
  assert.equal(failed.closed.length, 0);
  const done = await closeMany({ ...f, agents: f.make(), admitTogether: async () => { throw Error('must not re-admit a prepared decision'); } }, input);
  assert.equal(done.closed.length, 2); assert.deepEqual(done.problems, []);
  assert.equal(f.calls.filter(([kind]) => kind === 'decide').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'carried').length, 1);
});

test('reordered digest retry after an interrupted digest link reuses exactly the same kept work', async () => {
  const f = fixture(), rows = [f.job(), f.job()], input = f.input(rows, 'digest');
  let digest;
  const failed = await closeMany({ ...f, agents: { ...f.agents,
    handOff: request => { const result = f.agents.handOff(request); digest = result.handoff.handoff_id; return result; },
    keepCloseDigest: () => { throw Error('reset before linking digest'); },
  } }, input);
  assert.equal(failed.closed.length, 0); assert.ok(digest);
  const done = await closeMany({ ...f, agents: f.make() }, { ...input, items: [...input.items].reverse() });
  assert.equal(done.closed.length, 2); assert.equal(done.digest.into, digest);
});

test('direct waiting closure uses the same authoritative eligibility as reservation', () => {
  const f = fixture(), item = f.job(); f.agents.take({ handoff_id: item.handoff_id, agent_id: 'runner' });
  assert.throws(() => f.agents.closeWaiting({ handoff_id: item.handoff_id, by: 'sorter', result: { state: 'handled' } }), /being worked on/);
  assert.equal(f.store.handoff(item.handoff_id).state, 'taken');
});

test('internal sender retirement during admission prevents subsequent source decision side effects', async () => {
  const f = fixture(), item = f.job({ from_agent: 'requester' }), input = f.input([item]);
  let release;
  const flight = closeMany({ ...f, admit: async id => { await new Promise(resolve => { release = resolve; }); return f.admit(id); } }, input);
  await turn();
  f.agents.withdraw({ handoff_id: item.handoff_id, by: 'requester', result: { state: 'withdrawn' } });
  release(); const result = await flight;
  assert.equal(result.closed.length, 0);
  assert.deepEqual(f.calls.filter(([kind]) => ['decide','carried'].includes(kind)), []);
});

for (const stage of ['get', 'guide read', 'guide answer', 'decideGuided', 'recordCarriedOut']) test(`retirement during ${stage} fences every later source call and final closure`, async () => {
  const f = fixture(), item = f.job({ from_agent: 'requester' }), input = f.input([item]);
  let release, waiting = false, answered = false;
  const engine = { ...f.engine, guide: async (id, answer) => {
    f.calls.push(['guide', id, answer]);
    if (answer) { answered = true; return {}; }
    return answered ? {} : { question: { step_id: 'scope' } };
  } };
  const method = stage.startsWith('guide') ? 'guide' : stage;
  const original = engine[method];
  engine[method] = async (...args) => {
    const result = await original(...args);
    const selected = stage === 'guide read' ? !args[1] : stage === 'guide answer' ? Boolean(args[1]) : true;
    if (selected && !waiting) { waiting = true; await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const flight = closeMany({ ...f, engine }, input);
  await turn(); assert.equal(waiting, true);
  f.agents.withdraw({ handoff_id: item.handoff_id, by: 'requester', result: { state: 'withdrawn' } });
  const before = structuredClone(f.calls);
  release(); const result = await flight;
  assert.equal(result.closed.length, 0); assert.deepEqual(f.calls, before);
  assert.equal(f.store.handoff(item.handoff_id).result.state, 'withdrawn');
});
