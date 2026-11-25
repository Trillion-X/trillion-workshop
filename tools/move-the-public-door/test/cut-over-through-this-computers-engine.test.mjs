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
