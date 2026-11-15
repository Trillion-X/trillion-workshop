import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPaidGrantReadback, verifyPaidProofOwner } from '../scripts/paid-proof-account.mjs';

test('paid proof grant proceeds only when returned account access includes kept decisions', () => {
  assert.deepEqual(verifyPaidGrantReadback({ access: { capabilities: ['access:decision-kept'] } }), {
    capabilities: ['access:decision-kept'],
  });
  for (const answer of [null, {}, { access: {} }, { access: { capabilities: [] } }, { access: { capabilities: ['access:tool-spend'] } }]) {
    assert.throws(() => verifyPaidGrantReadback(answer), /readback does not include paid decision access/);
  }
});

test('paid proof preflight uses the operator-authority endpoint rather than the account endpoint', async () => {
  const requests = [];
  const result = await verifyPaidProofOwner('https://example.test', 'unused-keychain', {
    operatorKey: 'synthetic-key', request: async (url, options) => {
      requests.push({ url, method: options.method ?? 'GET', authorization: options.headers.authorization });
      return Response.json({ authority: 'operator', rules: [] });
    },
  });
  assert.deepEqual(result, { available: true });
  assert.deepEqual(requests, [{ url: 'https://example.test/mcp/api/show-rules', method: 'GET', authorization: 'Bearer synthetic-key' }]);
});

test('paid proof preflight fails closed for a different authority and actual service refusal', async () => {
  for (const [authority, status] of [['account', 200], ['operator', 503], ['operator', 403]]) {
    await assert.rejects(verifyPaidProofOwner('https://example.test', 'unused-keychain', {
      maxAttempts: 1,
      operatorKey: 'synthetic-key', request: async () => Response.json({ authority, rules: [] }, { status }),
    }), /Proof workspace policy owner read/);
  }
});

test('paid preflight retries a busy read without creating or granting an account', async () => {
  const attempts = [];
  const calls = [];
  const answer = await verifyPaidProofOwner('https://example.test', 'unused-keychain', {
    operatorKey: 'synthetic-key', retryDelayMs: 0,
    onAttempt: row => attempts.push(row.status),
    request: async (url, options) => {
      calls.push({ url, method: options.method ?? 'GET' });
      return calls.length === 1 ? Response.json({ code: 'service-busy' }, { status: 503, headers: { 'retry-after': '0' } })
        : Response.json({ authority: 'operator' });
    },
  });
  assert.deepEqual(answer, { available: true });
  assert.deepEqual(attempts, [503, 200]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(row => row.method === 'GET' && row.url.endsWith('/show-rules')));
});

test('paid preflight bounds repeated busy reads and never retries an authority refusal', async () => {
  for (const [status, authority, expectedCalls] of [[503, undefined, 3], [403, undefined, 1], [200, 'account', 1]]) {
    let calls = 0;
    await assert.rejects(verifyPaidProofOwner('https://example.test', 'unused-keychain', {
      operatorKey: 'synthetic-key', maxAttempts: 3, retryDelayMs: 0,
      request: async () => { calls += 1; return Response.json({ authority }, { status }); },
    }), /Proof workspace policy owner read/);
    assert.equal(calls, expectedCalls);
  }
});

test('cancelling a paid preflight prevents another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(verifyPaidProofOwner('https://example.test', 'unused-keychain', {
    operatorKey: 'synthetic-key', signal: controller.signal,
    onAttempt: () => controller.abort(new Error('stopped')),
    request: async () => { calls += 1; return Response.json({}, { status: 503 }); },
  }), /stopped/);
  assert.equal(calls, 1);
});

test('a read-only owner timeout retries, while unknown transport failures do not', async () => {
  for (const [error, expectedCalls] of [
    [new DOMException('Read timed out', 'TimeoutError'), 2],
    [new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), 2],
    [new Error('unknown transport failure'), 1],
  ]) {
    let calls = 0;
    const run = verifyPaidProofOwner('https://example.test', 'unused-keychain', {
      operatorKey: 'synthetic-key', retryDelayMs: 0,
      request: async () => { if (++calls === 1) throw error; return Response.json({ authority: 'operator' }); },
    });
    if (expectedCalls === 2) assert.deepEqual(await run, { available: true });
    else await assert.rejects(run, /unknown transport failure/);
    assert.equal(calls, expectedCalls);
  }
});

test('a busy retry wait ends at the preflight deadline', async () => {
  let calls = 0;
  await assert.rejects(verifyPaidProofOwner('https://example.test', 'unused-keychain', {
    operatorKey: 'synthetic-key', timeoutMs: 5, retryDelayMs: 1000,
    request: async () => { calls += 1; return Response.json({}, { status: 503 }); },
  }), /Proof workspace policy owner read/);
  assert.equal(calls, 1);
});

test('cancelling during a busy retry wait stops without another read', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(verifyPaidProofOwner('https://example.test', 'unused-keychain', {
    operatorKey: 'synthetic-key', signal: controller.signal,
    onAttempt: () => setTimeout(() => controller.abort(), 5),
    request: async () => { calls += 1; return Response.json({}, { status: 503 }); },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
