import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceFactsTools } from '../src/device-facts-tools.mjs';

test('device facts tool forwards optional source identity fields and preserves legacy calls', async () => {
  const calls = [];
  const [tool] = deviceFactsTools(async (...args) => { calls.push(args); return { ok: true }; });
  const legacy = { device: 'Mac', facts: { cameras: 'Camera A' } };
  await tool.run(legacy);
  assert.deepEqual(calls[0], ['/device-facts', legacy]);

  const identified = { ...legacy, device_id: 'profile-a', source: 'always-recording', generation: '1791561600000000-page-abcd-00000001' };
  await tool.run(identified);
  assert.deepEqual(calls[1], ['/device-facts', identified]);
  assert.match(tool.inputSchema.properties.generation.oneOf[1].pattern, /page-/);
  assert.throws(() => tool.run({ ...legacy, device_id: 'profile-a' }), /must be supplied together/);
});
