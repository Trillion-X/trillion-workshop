import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { observeHostedProviders, validateCredentialRows, vaultInventory } from '../do-work/observe-hosted-provider.mjs';

const source = JSON.parse(await readFile(new URL('../read-data/hosted-provider-source.json', import.meta.url), 'utf8'));
const accountId = 'a'.repeat(32);
const secret = 'this-is-a-private-token-that-must-not-appear';
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
// Holder names are the person's own; the code learns them only from these rows.
const credentials = { schema: 'hosted-provider-credentials/1', rows: [
  { provider: 'cloudflare', holders: { token: 'held-token-one', account_endpoint: 'held-endpoint-one' } },
] };

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

test('hosted provider observer uses explicit official requests and emits only safe projections', async () => {
  const calls = [];
  const vault = {
    async heldByTheVault(holder) {
      if (holder === 'held-token-one') return secret;
      if (holder === 'held-endpoint-one') return { endpoint };
      throw new Error('unexpected credential holder');
    },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (url.pathname.endsWith('/user/tokens/verify')) return jsonResponse(200, { success: true, result: { id: 'private-account', status: 'active' } });
    if (url.pathname.endsWith(`/accounts/${accountId}`)) return jsonResponse(200, { success: true, result: { id: 'private-account', name: 'private-account-name' } });
    if (url.pathname.endsWith(`/accounts/${accountId}/subscriptions`)) return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'private billing body' }] });
    const query = JSON.parse(options.body).query;
    if (query.includes('workersInvocationsAdaptive')) return jsonResponse(200, { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 12, errors: 1 }, quantiles: { cpuTimeP50: 7, cpuTimeP99: 99 } }] }] } } });
    if (query.includes('r2OperationsAdaptiveGroups')) return jsonResponse(200, { data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [{ dimensions: { actionType: 'GetObject' }, sum: { requests: 4 } }, { dimensions: { actionType: 'PutObject' }, sum: { requests: 2 } }] }] } } });
    if (query.includes('r2StorageAdaptiveGroups')) return jsonResponse(200, { data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [
      { dimensions: { bucketName: 'private-bucket-a', datetime: '2026-11-01T00:00:00Z' }, max: { objectCount: 2, uploadCount: 3, payloadSize: 40, metadataSize: 4 } },
      { dimensions: { bucketName: 'private-bucket-a', datetime: '2026-11-01T01:00:00Z' }, max: { objectCount: 2, uploadCount: 3, payloadSize: 50, metadataSize: 5 } },
      { dimensions: { bucketName: 'private-bucket-b', datetime: '2026-11-01T00:00:00Z' }, max: { objectCount: 1, uploadCount: 1, payloadSize: 20, metadataSize: 2 } },
    ] }] } } });
    if (query.includes('r2BandwidthUsageAdaptiveGroups')) return jsonResponse(200, { data: { viewer: { accounts: [{ r2BandwidthUsageAdaptiveGroups: [
      { sum: { bytesUpload: 100, bytesDownload: 200 }, dimensions: { datetimeHour: '2026-11-01T00:00:00Z' } },
      { sum: { bytesUpload: 0, bytesDownload: 50 }, dimensions: { datetimeHour: '2026-11-01T01:00:00Z' } },
    ] }] } } });
    throw new Error('unexpected URL');
  };
  const now = new Date('2026-11-01T02:00:00.000Z');
  const observed = await observeHostedProviders({ source, credentials, vault, fetchImpl, now });
  assert.equal(observed.observation_count, 7);
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.url.origin === 'https://api.cloudflare.com'));
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  assert.ok(calls.every(call => call.options.headers.authorization === `Bearer ${secret}`));
  const bandwidthQuery = JSON.parse(calls.find(call => call.url.pathname.endsWith('/graphql') && JSON.parse(call.options.body).query.includes('r2BandwidthUsageAdaptiveGroups')).options.body).query;
  assert.match(bandwidthQuery, /orderBy:\s*\[datetimeHour_ASC\]/);
  assert.match(bandwidthQuery, /dimensions\s*\{\s*datetimeHour\s*\}/);
  const byId = Object.fromEntries(observed.observations.map(item => [item.observation_id, item]));
  assert.equal(byId['workers-invocations-24h'].result.sums.requests.value, 12);
  assert.equal(byId['workers-invocations-24h'].result.quantiles.cpuTimeP99.unit, 'millisecond');
  assert.equal(byId.subscriptions.http_status, 403);
  assert.deepEqual(byId.subscriptions.result.provider_error_codes, [10000]);
  assert.deepEqual(byId['r2-operations-24h'].result.operation_categories, [{ operation: 'GetObject', requests: 4 }, { operation: 'PutObject', requests: 2 }]);
  assert.equal(byId['r2-storage-24h'].result.values.payload_bytes.value, 70);
  assert.equal(byId['r2-storage-24h'].result.group_count, 2);
  assert.equal(byId['r2-bandwidth-24h'].result.sums['sum.bytesUpload'].value, 100);
  assert.equal(byId['r2-bandwidth-24h'].result.sums['sum.bytesDownload'].value, 250);
  const output = JSON.stringify(observed);
  for (const forbidden of [secret, accountId, 'private-account', 'private-bucket-a', 'private-bucket-b', 'private billing body']) assert.ok(!output.includes(forbidden));
  assert.ok(byId['workers-invocations-24h'].request_body_bytes.value > 0);
  assert.equal(byId['workers-invocations-24h'].attempts, 1);
  assert.equal(byId['workers-invocations-24h'].retries, 0);
});

test('vault inventory reports only holders the credential rows name, without exposing encoded holders or values', async () => {
  const supabase = Buffer.from('service_connection:supabase', 'utf8').toString('hex');
  const account = Buffer.from('service_connection:supabase:account', 'utf8').toString('hex');
  const names = ['held-token-one', 'storage-key-pair', supabase, account, 'unrelated-secret', 'vendor-looking-but-unnamed-token'];
  const rows = { schema: 'hosted-provider-credentials/1', rows: [
    { provider: 'cloudflare', holders: { token: 'held-token-one', account_endpoint: 'not-in-the-vault' } },
    { provider: 'object-storage', holders: { key: 'storage-key-pair' } },
    { provider: 'supabase', service_connection: 'supabase' },
  ] };
  const inventory = await vaultInventory({
    async namesHeldByTheVault() { return names; },
    shapeHeldByTheVault(name) {
      if (name === 'held-token-one') return 'bare';
      if (name === 'storage-key-pair') return { fields: ['applicationKeyId', 'applicationKey'] };
      return { fields: ['project_url', 'service_role_key'] };
    },
  }, rows);
  assert.equal(inventory.filter(item => item.holder_kind !== 'not_held').length, 4);
  assert.deepEqual(inventory.find(item => item.holder_kind === 'not_held'), { provider: 'cloudflare', holder_kind: 'not_held', missing_roles: ['account_endpoint'] });
  assert.deepEqual(inventory.filter(item => item.provider === 'supabase').map(item => item.fields), [['project_url', 'service_role_key'], ['project_url', 'service_role_key']]);
  assert.deepEqual(inventory.find(item => item.provider === 'object-storage').fields, ['applicationKey', 'applicationKeyId']);
  const output = JSON.stringify(inventory);
  for (const hidden of [supabase, account, 'unrelated-secret', 'vendor-looking-but-unnamed-token', 'held-token-one', 'storage-key-pair']) assert.ok(!output.includes(hidden));
});

test('a provider with no credential row is reported unconfigured and the vault is never read', async () => {
  const vault = { async heldByTheVault() { throw new Error('the vault must not be read'); } };
  const fetchImpl = async () => { throw new Error('no request without a credential row'); };
  const observed = await observeHostedProviders({ source, credentials: { schema: 'hosted-provider-credentials/1', rows: [] }, vault, fetchImpl });
  assert.equal(observed.observation_count, 0);
  assert.deepEqual(observed.unconfigured_providers, source.providers.map(provider => provider.id));
});

test('credential rows are refused when they are not hosted-provider-credentials/1 rows', () => {
  assert.throws(() => validateCredentialRows(undefined), /hosted-provider-credentials\/1/);
  assert.throws(() => validateCredentialRows({ schema: 'hosted-provider-credentials/1', rows: [{ provider: 'cloudflare' }] }), /names no holder/);
  assert.throws(() => validateCredentialRows({ schema: 'hosted-provider-credentials/1', rows: [{ provider: 'cloudflare', holders: { password: 'x' } }] }), /unknown holder role/);
  assert.throws(() => validateCredentialRows({ schema: 'hosted-provider-credentials/1', rows: [
    { provider: 'cloudflare', holders: { token: 'a' } }, { provider: 'cloudflare', holders: { token: 'b' } },
  ] }), /repeats provider/);
});
