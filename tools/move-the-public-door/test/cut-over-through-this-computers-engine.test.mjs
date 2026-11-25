// The cut-over of one name at a provider that keeps no record ids, reached through the engine (the published Namecheap
// description, read as it is, behind the made-up zone of namecheap-world.mjs), run as the runner runs it: prepare keeps the
// original record in the receipt; activate adds the new record, then removes the original by its body, and never leaves the
// name with no address; rollback puts the original address back the same way; other records and the redirect record the
// typed list omits stay as they were; a lost answer is found again by readback, never sent twice; and a keyed description, or
// a name holding a record nobody placed, is refused with no mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutOverThroughThisComputersEngine, engineCall } from '../do-work/cut-over-through-this-computers-engine.mjs';
import { namecheapWorld as world, provider, host, ROW, OLD } from './namecheap-world.mjs';

const aRecord = (name, address) => ({ type: 'A', name, address, ttl: 60 });
const txt = (name, value) => ({ type: 'TXT', name, value, ttl: 300 });
const run = (w, action, receipt) => cutOverThroughThisComputersEngine({ action, hostname: host, address: ROW, dns: provider, receipt }, { call: w.call });

test('prepare, activate and rollback move the one record by its body, adding before removing', async () => {
  const w = world([txt('@', 'v=spf1 -all'), aRecord('files', OLD), aRecord('www', OLD)], { omitted: [{ type: 'URL', name: '@' }] });
  const prepared = await run(w, 'prepare');
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.receipt.mode, 'record-by-body');
  assert.equal(prepared.original.address, OLD, 'the receipt keeps the original record, which has no id');
  assert.deepEqual([w.state.saves, w.state.deletes], [[], []], 'prepare changes nothing');

  const active = await run(w, 'activate', prepared.receipt);
  assert.equal(active.state, 'active');
  assert.equal(active.current.address, ROW);
  assert.deepEqual(w.state.saves, [[aRecord('files', ROW)]]);
  assert.deepEqual(w.state.deletes, [[{ type: 'A', name: 'files', address: OLD }]]);
  const order = w.state.calls.filter(name => name !== 'dns_records_get' && name !== 'domains_list');
  assert.deepEqual(order, ['dns_records_save', 'dns_records_delete'], 'the new record is added before the original is removed');
  assert.deepEqual(w.state.records.filter(x => x.name !== 'files'), [txt('@', 'v=spf1 -all'), aRecord('www', OLD)], 'other records are kept');

  const again = await run(w, 'activate', active.receipt);
  assert.equal(again.state, 'active');
  assert.equal(w.state.saves.length + w.state.deletes.length, 2, 'an activate already done sends nothing more');

  const back = await run(w, 'rollback', active.receipt);
  assert.equal(back.state, 'rolled-back');
  assert.deepEqual(w.state.records.filter(x => x.name === 'files'), [aRecord('files', OLD)]);
  assert.deepEqual(w.state.saves.at(-1), [aRecord('files', OLD)]);
  assert.deepEqual(w.state.deletes.at(-1), [{ type: 'A', name: 'files', address: ROW }]);
});

test('an activate whose add was made but whose answer was lost goes on to the remove, never adding twice', async () => {
  const w = world([aRecord('files', OLD)]);
  const prepared = await run(w, 'prepare');
  w.state.records.push(aRecord('files', ROW));
  const active = await run(w, 'activate', prepared.receipt);
  assert.equal(active.state, 'active');
  assert.deepEqual([w.state.saves, w.state.deletes], [[], [[{ type: 'A', name: 'files', address: OLD }]]]);
});

test('a name holding an address record this cutover did not place is refused with no mutation', async () => {
  const w = world([aRecord('files', OLD)]);
  const prepared = await run(w, 'prepare');
  w.state.records.push(aRecord('files', '192.0.2.9'));
  await assert.rejects(run(w, 'activate', prepared.receipt), /did not place/);
  assert.deepEqual([w.state.saves, w.state.deletes], [[], []]);
});

test('a change to another record between prepare and activate is refused with no mutation', async () => {
  const w = world([aRecord('files', OLD), aRecord('www', OLD)]);
  const prepared = await run(w, 'prepare');
  w.state.records[1] = aRecord('www', '192.0.2.9');
  await assert.rejects(run(w, 'activate', prepared.receipt), /Unrelated DNS records/);
  assert.deepEqual([w.state.saves, w.state.deletes], [[], []]);
});

test('a keyed description is refused: it runs as the tool, whose row mounts its key', async () => {
  const w = world([aRecord('files', OLD)]);
  const keyed = { ...provider, transport: undefined };
  await assert.rejects(cutOverThroughThisComputersEngine({ action: 'prepare', hostname: host, address: ROW, dns: keyed }, { call: w.call }), /reached through the engine/);
  assert.deepEqual(w.state.calls, []);
});

test('the engine call sends the run on standard input to `<engine command> op tools:run -` and reads its JSON answer', () => {
  let seen;
  const spawn = (command, args, options) => { seen = { command, args, input: JSON.parse(options.input), timeout: options.timeout }; return { status: 0, stdout: '{"result":{"structuredContent":{"ok":true}}}' }; };
  const answer = engineCall({ address: provider.base, tool: 'mcp.namecheap.com/dns_records_get', input: { domainName: 'example.org' } }, { spawn, command: 'engine' });
  assert.deepEqual(answer, { result: { structuredContent: { ok: true } } });
  assert.deepEqual([seen.command, seen.args], ['engine', ['op', 'tools:run', '-']]);
  assert.equal(seen.input.tool, 'mcp.namecheap.com/dns_records_get');
  assert.ok(seen.timeout < 120000, 'the runner waits less than one CLI try, so it never asks a run twice');
  assert.throws(() => engineCall({ tool: 't' }, { spawn: () => ({ status: 1, stdout: '' }), command: 'engine' }), /did not finish/);
  assert.throws(() => engineCall({ tool: 't' }, { spawn, command: '' }), /ENGINE_COMMAND/);
});

// The same cut-over stepped as a workflow steps it: each step replays the cut-over against the answers kept so far and names
// the next request, which the test answers from the made-up zone as the workflow's fixed ask step would, until it is done.
import { stepACutover } from '../do-work/door-tools.mjs';
async function stepped(w, cutover, receipt) {
  const transcript = [];
  for (let pass = 0; pass < 60; pass += 1) {
    const turn = await stepACutover({ action: 'step', cutover, hostname: host, address: ROW, dns: provider, receipt, transcript });
    assert.equal(turn.asked, transcript.length, 'each kept answer is used once, in order');
    if (turn.done) return { answer: turn.answer, transcript };
    assert.ok(Object.values(provider.requests).some(asked => asked.body_template?.name === turn.next.name), `${turn.next.name} is a tool the description declares`);
    transcript.push({ request: turn.next, answer: await w.call({ address: provider.base, tool: `mcp.namecheap.com/${turn.next.name}`, input: turn.next.arguments }) });
  }
  throw new Error('the cut-over never finished');
}

test('stepped, prepare, activate and rollback send the same requests and leave the same zone as one call does', async () => {
  const records = () => [txt('@', 'v=spf1 -all'), aRecord('files', OLD), aRecord('www', OLD)];
  const once = world(records()), steps = world(records());
  const p1 = await run(once, 'prepare'), a1 = await run(once, 'activate', p1.receipt), r1 = await run(once, 'rollback', a1.receipt);
  const p2 = await stepped(steps, 'prepare'), a2 = await stepped(steps, 'activate', p2.answer.receipt), r2 = await stepped(steps, 'rollback', a2.answer.receipt);
  assert.deepEqual([p2.answer.state, a2.answer.state, r2.answer.state], ['prepared', 'active', 'rolled-back']);
  assert.deepEqual(steps.state.calls, once.state.calls, 'the same requests in the same order');
  assert.deepEqual([steps.state.saves, steps.state.deletes, steps.state.records], [once.state.saves, once.state.deletes, once.state.records]);
  assert.deepEqual([a2.answer.current, r2.answer.state], [a1.current, r1.state]);
});

test('a step whose kept answers were for another request refuses, and a keyed description or no cut-over name is refused', async () => {
  const w = world([aRecord('files', OLD)]);
  const first = await stepACutover({ action: 'step', cutover: 'prepare', hostname: host, address: ROW, dns: provider, transcript: [] });
  assert.equal(first.done, false);
  const wrong = [{ request: { ...first.next, arguments: { domain: 'other.example' } }, answer: {} }];
  await assert.rejects(stepACutover({ action: 'step', cutover: 'prepare', hostname: host, address: ROW, dns: provider, transcript: wrong }), /belong to another cut-over/);
  await assert.rejects(stepACutover({ action: 'step', cutover: 'prepare', hostname: host, address: ROW, dns: { ...provider, transport: undefined }, transcript: [] }), /reached through the engine/);
  await assert.rejects(stepACutover({ action: 'step', hostname: host, address: ROW, dns: provider, transcript: [] }), /names the cut-over/);
  assert.deepEqual(w.state.calls, [], 'a step reaches nothing itself');
});

test('stepped the way the workflow passes it on (each answer joined through add, the answer\'s transcript handed on as it is), the cut-over ends the same', async () => {
  const records = () => [aRecord('files', OLD), txt('@', 'v=spf1 -all')];
  const once = world(records()), steps = world(records());
  const p1 = await run(once, 'prepare'); await run(once, 'activate', p1.receipt);
  const go = async (cutover, receipt) => {
    let turn = await stepACutover({ action: 'step', cutover, hostname: host, address: ROW, dns: provider, receipt });
    for (let pass = 0; turn.more && pass < 60; pass += 1) {
      assert.equal(turn.done, false);
      const answer = await steps.call({ address: provider.base, tool: `mcp.namecheap.com/${turn.next.name}`, input: turn.next.arguments });
      // A workflow engine hands objects back with their keys sorted, so the kept request comes back reordered.
      const sorted = value => (Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value);
      turn = await stepACutover({ action: 'step', cutover, hostname: host, address: ROW, dns: provider, receipt, transcript: sorted(turn.transcript), add: sorted({ request: turn.next, answer }) });
    }
    assert.equal(turn.done, true);
    return turn.answer;
  };
  const prepared = await go('prepare'); const active = await go('activate', prepared.receipt);
  assert.equal(active.state, 'active');
  assert.deepEqual([steps.state.calls, steps.state.records], [once.state.calls, once.state.records]);
});
