// Ported from old trillion test/failure-payload.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The registry is tools/set-up-my-account/read-data/failure-codes.json, which this tool's
// src/failure.mjs reads. Left out: the second test's calls through the retired MCP handler (src/tools.mjs
// handleMcpMessage, which shaped a thrown refusal into structuredContent); no running JS code has that handler (searched
// the three repos for handleMcpMessage: only held copies). Its last two assertions, over payloadOf, are the old ones.
// test/failure-payload.test.mjs
// Every failure code is registered with a domain and the payload fields it may carry; an answer carries only those (F-0908).
import assert from 'node:assert/strict';
import test from 'node:test';
import codes from '../../set-up-my-account/read-data/failure-codes.json' with { type: 'json' };
import { failureOf, payloadOf } from '../src/failure.mjs';

test('every registered code has a domain and a payload list', () => {
  for (const [code, row] of Object.entries(codes)) {
    assert.equal(typeof row.domain, 'string', code);
    assert.ok(Array.isArray(row.payload), code);
  }
});

test('a refusal carries next_call and domain; an unregistered code ships no payload', async () => {
  const next = { tool: 'read_handoff', arguments: {} };
  assert.deepEqual(payloadOf(failureOf(new Error('x')), { failure_code: 'made-up', next_call: next }), {});
  assert.deepEqual(payloadOf(failureOf(new Error('x')), { next_call: next }), { next_call: next });
});
