// tools/forward-a-fact-to-my-computer/test/wake-rows.test.mjs
// Every wake of this tool uses only keys the engine accepts (the engine's src/wake.rs, struct Declaration, deny_unknown_fields:
// a wake with any other key is refused as unknown_setting and never runs), hears one kind from its own teller, and needs
// both parts of the input a forward cannot run without. The row holds the key it is handed by its held name, on descriptor 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS } from '../do-work/forward-a-fact.mjs';

const ENGINE_WAKE_KEYS = ['id', 'on', 'budget', 'input', 'until', 'retry', 'skip_unchanged', 'rate', 'replay', 'needs_input', 'on_failure'];
const [{ payload: row }] = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records;

test('every wake uses only keys the engine accepts and hears one kind from its teller, needing to, door and forwarded_from', () => {
  assert.ok(row.wakes.length > 0);
  const kinds = new Set();
  for (const wake of row.wakes) {
    assert.deepEqual(Object.keys(wake).filter(key => !ENGINE_WAKE_KEYS.includes(key)), [], `${wake.id} uses a key the engine does not accept`);
    const heard = wake.on.fact;
    assert.equal(wake.id, `forward-${heard.kind}`);
    assert.ok(Array.isArray(heard.from) && heard.from.length > 0, `${wake.id} names its teller`);
    assert.ok(!kinds.has(heard.kind), `${heard.kind} has one wake`);
    kinds.add(heard.kind);
    assert.deepEqual(wake.needs_input, ['to', 'door', 'forwarded_from']);
    assert.ok(wake.retry.attempts > 1 && wake.retry.first_ms > 0, `${wake.id} asks a failed forward again`);
  }
});

test('the row mounts the held key by name on descriptor 3, its own door on descriptor 4, gives the run its fact and input, and names no host itself', () => {
  assert.deepEqual(row.invoke.key, [{ secret_name: SETTINGS.key_name, fd: 3 }]);
  assert.deepEqual(row.invoke.stdin, { input: { fill: { from: 'input' } }, fact: { fill: { from: 'task', field: 'cause.detail' } } });
  assert.deepEqual(row.invoke.may_reach, [], "the key's own hosts fence the run");
  assert.deepEqual(row.input_schema.required, ['to', 'door', 'forwarded_from']);
  // The run reads this computer's wakes of each kind it forwards, and nothing else, on its door.
  assert.equal(row.invoke.records.fd, SETTINGS.door_descriptor);
  assert.deepEqual(row.invoke.records.rights, row.wakes.map(wake => ({ at: '@own-records', id: wake.on.fact.kind, operations: ['wake:list'] })));
});
