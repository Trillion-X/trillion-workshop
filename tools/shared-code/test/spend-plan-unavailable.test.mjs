// Ported from old trillion test/spend-plan-unavailable.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. Its first four tests asked old src/native-resource-spend.mjs NativeResourceSpend spendList for
// the plan's row while its quota owner (the AccountControl Durable Object's quotaCurrent) could not say, failed, had no
// policy or answered; that spend owner went with the Worker and nothing makes the Spend list's plan row now (searched
// NativeResourceSpend, spendList, quotaCurrent, plan_spending in trillion-workshop tools/, trillion-apps web/, trillion-rust
// src/: keep-and-wake-ai-sessions-on-this-computer/src/model-calls.mjs asks quotaCurrent only to admit a paid model call, and
// trillion-apps names plan_spending only in test fixtures), so they are left out. The last test is the old one
// over src/spend-meter.json here.
import test from 'node:test';
import assert from 'node:assert/strict';
import spendData from '../src/spend-meter.json' with { type: 'json' };

test('the Spend screen\'s summary names the plan usage state in its own words', () => {
  const entry = spendData.view.summary?.find(row => row.id === 'plan-usage') ?? JSON.stringify(spendData).includes('Plan usage unavailable');
  assert.ok(entry);
});
