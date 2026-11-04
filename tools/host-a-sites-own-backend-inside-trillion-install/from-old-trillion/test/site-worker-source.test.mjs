import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSelfContainedWorkerModule, checkedSiteWorkerSourceManifest, pinnedWorkerAssets, pinnedWorkerPermissions } from '../src/site-worker-source.mjs';

const lock = { schema: 'trillion.source-build-inputs/v1', inputs: [
  { repository: 'owner/shared-data', commit: 'a'.repeat(40), mount: 'shared-data', paths: ['content'] },
] };
const manifest = {
  schema: 'trillion.site-worker-source/v1',
  compatibility_date: '2026-10-07', compatibility_flags: ['nodejs_compat'],
  module: { mount: 'source', path: 'dist/site-worker.mjs' },
  assets: [{ mount: 'source', path: 'dist/site.css', as: 'assets/site.css' }],
  data: [{ mount: 'shared-data', path: 'content/settings.json', as: 'data/settings.json' }],
};

test('pinned Worker manifest admits only a self-contained entry and files within exact declared mounts', () => {
  assert.deepEqual(checkedSiteWorkerSourceManifest(manifest, lock), manifest);
  assert.throws(() => checkedSiteWorkerSourceManifest({ ...manifest, data: [
    { mount: 'shared-data', path: 'private/settings.json', as: 'data/settings.json' },
  ] }, lock), /outside its locked source paths/);
  assert.throws(() => checkedSiteWorkerSourceManifest({ ...manifest, data: [
    { mount: 'missing', path: 'content/settings.json', as: 'data/settings.json' },
  ] }, lock), /undeclared source mount/);
  assert.throws(() => checkedSiteWorkerSourceManifest({ ...manifest, module: { mount: 'shared-data', path: 'content/worker.mjs' } }, lock), /entry module must be in the pinned source repository/);
  assert.throws(() => checkedSiteWorkerSourceManifest({ ...manifest, module: { mount: 'source', path: '../worker.mjs' } }, lock), /source path is invalid/);
  assert.throws(() => checkedSiteWorkerSourceManifest({ ...manifest, compatibility_flags: ['nodejs:internal'] }, lock), /manifest is invalid/);
});

test('Worker source refuses unbundled imports and keeps data files installation-addressable', () => {
  assert.equal(checkedSelfContainedWorkerModule('export default { fetch() { return new Response("ok"); } };'),
    'export default { fetch() { return new Response("ok"); } };');
  assert.throws(() => checkedSelfContainedWorkerModule('import { helper } from "./helper.mjs"; export default {};'), /imports unbundled code/);
  assert.throws(() => checkedSelfContainedWorkerModule('export default { fetch() { return import("./helper.mjs"); } };'), /imports unbundled code/);
  assert.equal(checkedSelfContainedWorkerModule('export default { fetch() { return new Response(import.meta.url); } };'),
    'export default { fetch() { return new Response(import.meta.url); } };');
  const checked = checkedSiteWorkerSourceManifest(manifest, lock);
  const files = pinnedWorkerAssets(checked, (mount, path) => new TextEncoder().encode(
    mount === 'source' ? 'body{color:#123}' : '{"theme":"dark"}'));
  assert.deepEqual(files, { 'assets/site.css': 'body{color:#123}', 'data/settings.json': '{"theme":"dark"}' });
  assert.throws(() => pinnedWorkerAssets(checked, () => undefined), /bytes are unavailable/);
});


test('pinned source permissions copy schedules and mail behavior without silently widening a live attachment', () => {
  const permissions = { crons: ['*/10 * * * *'], receive_email: true,
    outbound_hosts: ['api.example.com'], ai_models: ['@cf/meta/llama-3'],
    email_senders: [{ email: 'hello@example.com', name: 'Hello' }] };
  assert.deepEqual(checkedSiteWorkerSourceManifest({ ...manifest, permissions }, lock).permissions, permissions);
  assert.throws(() => checkedSiteWorkerSourceManifest({ ...manifest,
    permissions: { crons: '*/10 * * * *' } }, lock), /permissions are invalid/);
  assert.throws(() => checkedSiteWorkerSourceManifest({ ...manifest,
    permissions: { secrets: ['key'] } }, lock), /permissions are invalid/);
  const existing = { enabled: true, outbound_hosts: ['existing.example.com'], ai_models: [],
    crons: [], email_senders: [], receive_email: false };
  assert.deepEqual(pinnedWorkerPermissions(existing), existing);
  const copied = pinnedWorkerPermissions(existing, permissions);
  assert.deepEqual({ ...copied, enabled: true }, { ...permissions, enabled: true });
  assert.equal(copied.enabled, false, 'a new source grant takes a live Worker offline until explicitly enabled');
  assert.equal(pinnedWorkerPermissions({ ...permissions, enabled: true }, permissions).enabled, true,
    'retrying an unchanged source keeps its enabled state');
  const equivalent = { ...permissions,
    crons: ['0 * * * *', '*/10 * * * *', '*/10 * * * *'],
    outbound_hosts: ['second.example.com', 'api.example.com', 'api.example.com'],
    ai_models: ['@cf/second/model', '@cf/meta/llama-3', '@cf/meta/llama-3'],
    email_senders: [permissions.email_senders[0], { email: 'second@example.com', name: 'Second' }] };
  const reordered = { ...equivalent,
    crons: [...equivalent.crons].reverse(), outbound_hosts: [...equivalent.outbound_hosts].reverse(),
    ai_models: [...equivalent.ai_models].reverse(), email_senders: [...equivalent.email_senders].reverse() };
  assert.equal(pinnedWorkerPermissions({ ...equivalent, enabled: true }, reordered).enabled, true,
    'reordered and repeated equivalent grants do not switch off a live Worker');
  assert.equal(pinnedWorkerPermissions({ ...equivalent, enabled: true },
    { ...reordered, email_senders: [{ email: 'third@example.com', name: 'Third' }] }).enabled, false,
    'a real sender change does switch off a live Worker');
  assert.deepEqual(pinnedWorkerPermissions(existing, { crons: [] }), existing,
    'a source that leaves other permissions unspecified keeps them');
});
