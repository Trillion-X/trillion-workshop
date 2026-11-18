// The opt-in integration uses only the current Rust synthetic fixture executable supplied by the contained build.
// Old trillion: scripts/passkey-account.mjs:1. New home: scripts/isolated-proof-computer.mjs and Rust's isolated fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRequest, startIsolatedProofComputer } from '../scripts/isolated-proof-computer.mjs';
import { withProofAccount } from '../scripts/proof-account.mjs';

test('fixture TLS transport refuses non-HTTPS or non-localhost owners before any request', () => {
  for (const origin of ['http://localhost:8443', 'https://app.example.com', 'https://localhost:8443/account',
    'https://user:pass@localhost:8443', 'https://localhost:8443/?account=other', 'https://localhost:8443/#other']) {
    assert.throws(() => fixtureRequest(origin, 'synthetic CA'), /one HTTPS localhost origin/);
  }
});

test('fixture TLS transport refuses another origin, port or embedded credentials before network work', async () => {
  const request = fixtureRequest('https://localhost:8443', 'synthetic CA');
  for (const url of ['https://localhost:8444/sign-up', 'https://example.test/sign-up', 'https://user:pass@localhost:8443/sign-up']) {
    await assert.rejects(request(url), /refused another origin/);
  }
});

test('actual Rust HTTPS Computer and Chromium bind one synthetic account, then verify full fixture cleanup', {
  skip: !process.env.ISOLATED_COMPUTER_FIXTURE_BINARY,
  timeout: 120_000,
}, async () => {
  const fixture = await startIsolatedProofComputer({
    fixtureBinary: process.env.ISOLATED_COMPUTER_FIXTURE_BINARY,
    rustRoot: process.env.ISOLATED_COMPUTER_FIXTURE_RUST_ROOT,
  });
  let accountAddress;
  const result = await withProofAccount(fixture, async account => {
    accountAddress = account.address;
    assert.ok(/^[a-f0-9]{64}$/.test(account.accountId), 'independent internal account id is present');
    assert.notEqual(account.accountId, account.address, 'public address is separate from internal owner id');
    assert.ok(account.key.startsWith(`nm_${account.address}_`), 'the once-shown browser key names this account');
    assert.equal(account.accountOrigin, `${fixture.origin}/a/${account.address}`);
    const held = await fixture.readCreatedAccount(account.address);
    assert.equal(held.ownerId, account.accountId, 'the Rust Computer independently holds this exact account');
    // A fresh private account's current own-records read reaches the actual owner with the browser-created key.
    const response = await fixture.request(`${account.accountOrigin}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: {
        address: '@own-records', method: 'records:read', request_key: 'isolated-browser-empty-record', input: { id: 'synthetic-empty-note' },
      } } }),
    });
    assert.ok(response.ok, 'actual account MCP read answers');
    const body = await response.json();
    assert.ok(!body.error && body.result?.isError !== true, 'actual account owner admits the browser-created key');
    assert.equal(body.result?.structuredContent?.value, null, 'fresh synthetic account has no existing note');
    await assert.rejects(fixture.request('https://app.example.com/'), /refused another origin/);
    return 'synthetic browser account qualified';
  });
  assert.equal(result, 'synthetic browser account qualified');
  assert.deepEqual(fixture.closedEvidence, { closed: true, listener_closed: true, temporary_root_removed: true });
  await assert.rejects(fixture.readCreatedAccount(accountAddress), /no longer running/);
});
