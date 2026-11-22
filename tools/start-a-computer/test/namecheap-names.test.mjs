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
  await assert.rejects(keepTheNames(unpinned, { call: w.call, apply: true }), /runs\.engine_call/);
  await assert.rejects(keepTheNames(unpinned, { call: w.call, apply: false }), /runs\.engine_call/);
  assert.deepEqual(w.state.calls, [], 'nothing was sent to the engine');
});

test('an engine call is a command line with its program first and exactly one {run}', () => {
  for (const bad of [undefined, 'engine op {run}', ['{run}', 'x'], ['engine'], ['engine', 'tools:run'], ['engine', '{run}', '{run}'], ['engine', '', '{run}'], ['engine', 7, '{run}']]) {
    assert.throws(() => engineCallOf(bad), /engine_call/, JSON.stringify(bad));
  }
  assert.equal(typeof engineCallOf(ENGINE), 'function');
});

test('the computer row names its engine call once as DATA, so a request with none still keeps its names', async () => {
  const w = namecheapWorld([]);
  const fromRow = { computer_row: { name: 'someones-computer', address: ROW, runs: { units: [], names, engine_call: ENGINE } } };
  assert.equal(namesOf(fromRow)[0].provider.transport, 'engine');
  const kept = await keepTheNames(fromRow, { call: w.call, apply: true });
  assert.deepEqual(kept, [{ host_name: 'files.example.org', address: ROW, added: [ROW], removed: [] }]);
});

test('a DNS provider that does not answer is asked again, and one still silent leaves the name unanswered, never a failed apply', async () => {
  const w = namecheapWorld([]);
  let silent = 2;
  const flaky = async run => { if (silent > 0) { silent -= 1; throw Error('engine down'); } return w.call(run); };
  const kept = await keepTheNames(request(names), { call: flaky, apply: true, waits: [1, 1] });
  assert.deepEqual(kept, [{ host_name: 'files.example.org', address: ROW, added: [ROW], removed: [] }], 'two silences, then an answer');
  const never = async () => { throw Error('engine down'); };
  const applied = await keepTheNames(request(names), { call: never, apply: true, waits: [1, 1] });
  assert.equal(applied.length, 1);
  assert.match(applied[0].unanswered, /did not answer/);
  const read = await keepTheNames(request(names), { call: never, apply: false, waits: [1] });
  assert.equal(read[0].matches, false);
  assert.match(read[0].unanswered, /did not answer/);
});

test('a refusal that is not silence still ends the apply', async () => {
  const w = namecheapWorld([{ type: 'A', name: 'files', address: OLD, ttl: 60 }]);
  await assert.rejects(keepTheNames(request(names), { call: w.call, apply: true, waits: [1] }), /does not own/);
});

const PARKING = '192.0.2.50';
const adopting = [{ host_name: 'files.example.org', provider: 'tools/start-a-computer/providers/namecheap.json', adopt: true }];

test('a name the row adopts takes the name over: the parking record is removed and named in removed, the others stay', async () => {
  const w = namecheapWorld([{ type: 'A', name: 'files', address: PARKING, ttl: 60 }, { type: 'A', name: 'other', address: OLD, ttl: 60 }, { type: 'MX', name: '@', exchange: 'mx1.example.net', preference: 10, ttl: 3600 }]);
  const kept = await keepTheNames(request(adopting), { call: w.call, apply: true });
  assert.deepEqual(kept, [{ host_name: 'files.example.org', address: ROW, added: [ROW], removed: [PARKING] }]);
  assert.deepEqual(w.state.records.map(x => [x.type, x.name, x.address ?? x.exchange]), [['A', 'other', OLD], ['MX', '@', 'mx1.example.net'], ['A', 'files', ROW]]);
});

test('an adopted name whose redirect record the listing omits names it unremovable, and it is not sent to a delete', async () => {
  const w = namecheapWorld([], { omitted: [{ type: 'URL', name: 'files' }] });
  const kept = await keepTheNames(request(adopting), { call: w.call, apply: true });
  assert.deepEqual(kept, [{ host_name: 'files.example.org', address: ROW, added: [ROW], removed: [], unremovable: [{ type: 'URL', host_name: 'files.example.org' }] }]);
  assert.deepEqual(w.state.deletes, []);
});

test('a name the row does not adopt is refused while the parking record is there, and left as it is', async () => {
  const w = namecheapWorld([{ type: 'A', name: 'files', address: PARKING, ttl: 60 }]);
  await assert.rejects(keepTheNames(request(names), { call: w.call, apply: true }), /does not own/);
  assert.deepEqual(w.state.records, [{ type: 'A', name: 'files', address: PARKING, ttl: 60 }]);
});
