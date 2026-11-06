// Ported from old trillion test/operator-keeps-sign-in-apps.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The first test reads the tool row where it lives now,
// keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json; its assertions are the old ones.
// Left out: the second test (the operator keeps, reads and removes the values; any other account is refused). It ran the
// retired PersonStore's account action keep-service-values over old src/service-values.mjs, which is held here
// (from-old-trillion/src/service-values.mjs.held: its imports src/sign-in-again.mjs, src/resource-host.mjs and
// src/tool-run-call.mjs are not here). Searched the three repos for keep-service-values, keepServiceValues,
// servicePlainValues, "not a value this service holds", service_values, HELD_VALUES_ROOT_KEY and
// facebook-login-client-id: only that held file, tool and connection DATA (records.json hosted_client names,
// start-from-any-landing-page src/worker-secrets.json) and a held saved-logins test; no running code keeps these values.
// The service's own sign-in apps kept by the operator account's AI (tool:keep-the-services-sign-in-apps, account action
// keep-service-values in src/person-store.mjs over src/service-values.mjs): the same names the operator's Connections
// screen boxes take, sealed in the operator's box with the id kept readable, a name the DATA does not list refused,
// removal taking names out, the answer saying only which names are held, and every other account refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import tools from '../../keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json' with { type: 'json' };

test('the tool is listed as an account action that holds its values out of every kept input', () => {
  const tool = tools.records.find(row => row.payload.id === 'tool:keep-the-services-sign-in-apps').payload;
  assert.deepEqual(tool.invoke, { kind: 'account-action', action: 'keep-service-values' });
  assert.equal(tool.input_schema.properties.values.writeOnly, true);
});
