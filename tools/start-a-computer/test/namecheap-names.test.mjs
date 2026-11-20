// A computer row's names kept through the published Namecheap provider (tools/start-a-computer/providers/namecheap.json, named
// in the row by its path in this Workshop), sent through the engine: the request names its `engine_call`, the name is kept on the
// row's address, and a request with no engine_call, or one that is not a command line with one {run}, is refused before any call is sent. A made-up zone answers the engine call; no
// network and no real domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineCallOf, keepTheNames, namesOf } from '../do-work/start-a-computer.mjs';
import { namecheapWorld, ROW, OLD } from '../../move-the-public-door/test/namecheap-world.mjs';

const ENGINE = ['engine', 'op', 'tools:run', '{run}', '--json'];
const request = (names, extra = {}) => ({ engine_call: ENGINE, computer_row: { name: 'someones-computer', address: ROW, runs: { units: [], names } }, ...extra });
const names = [{ host_name: 'files.example.org', provider: 'tools/start-a-computer/providers/namecheap.json' }];

test('a computer row names its Namecheap host by the published provider path and keeps it on the row address through the engine', async () => {
  const w = namecheapWorld([{ type: 'TXT', name: '@', value: 'v=spf1 -all', ttl: 300 }]);
  assert.equal(namesOf(request(names))[0].provider.transport, 'engine');
  const kept = await keepTheNames(request(names), { call: w.call, apply: true });
  assert.deepEqual(kept, [{ host_name: 'files.example.org', address: ROW, added: [ROW], removed: [] }]);
  assert.deepEqual(w.state.records.map(x => [x.type, x.name, x.address ?? x.value]), [['TXT', '@', 'v=spf1 -all'], ['A', 'files', ROW]]);
  const read = await keepTheNames(request(names), { call: w.call, apply: false });
  assert.deepEqual(read, [{ host_name: 'files.example.org', address: ROW, answers: [ROW], matches: true }]);
});

test('a name another address answers is refused and left as it is', async () => {
  const w = namecheapWorld([{ type: 'A', name: 'files', address: OLD, ttl: 60 }]);
  await assert.rejects(keepTheNames(request(names), { call: w.call, apply: true }), /does not own/);
  assert.deepEqual(w.state.records, [{ type: 'A', name: 'files', address: OLD, ttl: 60 }]);
});

test('an engine provider whose request names no engine_call is refused before any call is sent', async () => {
  const w = namecheapWorld([]);
  const unpinned = request(names, { engine_call: undefined });
  await assert.rejects(keepTheNames(unpinned, { call: w.call, apply: true }), /names its engine_call/);
  await assert.rejects(keepTheNames(unpinned, { call: w.call, apply: false }), /names its engine_call/);
  assert.deepEqual(w.state.calls, [], 'nothing was sent to the engine');
});

test('an engine call is a command line with its program first and exactly one {run}', () => {
  for (const bad of [undefined, 'engine op {run}', ['{run}', 'x'], ['engine'], ['engine', 'tools:run'], ['engine', '{run}', '{run}'], ['engine', '', '{run}'], ['engine', 7, '{run}']]) {
    assert.throws(() => engineCallOf(bad), /engine_call/, JSON.stringify(bad));
  }
  assert.equal(typeof engineCallOf(ENGINE), 'function');
});
