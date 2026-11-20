// Ported from old trillion test/operator-keeps-sign-in-apps.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The first test reads the tool row where it lives now,
// keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json; its assertions are the old ones.
// The outcomes of the old second test (the operator keeps, reads and removes the values; any other account is refused) are
// the assertions in test/sign-in-app-values.test.mjs, run over do-work/sign-in-app-values.mjs (the port). This file keeps the
// row's assertions: the account action row where it lives now, keep-and-wake-ai-sessions-on-this-computer/records/.
// The row has no runner yet (trillion-rust src/tool_runs/tools.rs KINDS has no account-action kind); see the README.
import assert from 'node:assert/strict';
import test from 'node:test';
import tools from '../../keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json' with { type: 'json' };

test('the tool is listed as an account action that holds its values out of every kept input', () => {
  const tool = tools.records.find(row => row.payload.id === 'tool:keep-the-services-sign-in-apps').payload;
  assert.deepEqual(tool.invoke, { kind: 'account-action', action: 'keep-service-values' });
  assert.equal(tool.input_schema.properties.values.writeOnly, true);
});
