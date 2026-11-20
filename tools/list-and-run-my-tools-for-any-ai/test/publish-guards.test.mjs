// tools/list-and-run-my-tools-for-any-ai/test/publish-guards.test.mjs
//
// The host-version guard of the old publishTool (src/workshop.mjs:1707): a release that needs a newer host version. The caller-only
// licence guard (:942, :1709-1710) is not in publishTool yet; its licence catalogue is not packaged DATA for this tool (a To do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishTool, refuseHostVersion, compareVersions } from '../do-work/publish-tool.mjs';
import { savedAndListedDatabase } from './saved-and-listed-database.mjs';

const descriptor = {
  kind: 'ai-tool-descriptor', id: 'tool:echo-test', job: 'Echo the input text back',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  invoke: { kind: 'container', argv: ['python3', 'main.py'], workdir: '/work' },
  can_do: ['Echo the text back'], cannot_do: ['Send messages'],
  verify: [{ kind: 'sample-run', input: { text: 'hi' } }],
  licence_class: 'licence:maker-own', placements: ['placement:small-container'],
};
const files = Buffer.from('print(1)');
const facts = { host_version: '2026.11.20' };
const database = (row = descriptor) => savedAndListedDatabase({ saved: [{ id: 'tool:echo-test', descriptor: row, fingerprint: '1f:aa', files }] });

test('versions compare part by part, missing parts counting as zero', () => {
  assert.ok(compareVersions('2026.9.28', '2026.11.20') < 0);
  assert.equal(compareVersions('2026.11', '2026.11.0'), 0);
  assert.ok(compareVersions('2026.11.20', '2026.9.28') > 0);
});

test('host version: no minimum passes; a minimum this host meets passes; a newer minimum is refused with both versions', () => {
  assert.equal(refuseHostVersion(descriptor, undefined), null);
  assert.equal(refuseHostVersion({ ...descriptor, minimum_host_version: '2026.9.28' }, '2026.11.20'), null);
  assert.equal(refuseHostVersion({ ...descriptor, minimum_host_version: '2026.11.20' }, '2026.11.20'), null);
  assert.equal(refuseHostVersion({ ...descriptor, minimum_host_version: '2026.12.1' }, '2026.11.20'),
    'tool:echo-test says it needs version 2026.12.1 or newer, and the host publishing it is 2026.11.20, so its sample cannot be checked here.');
});

test('host version: an earlier release this host runs is enough; a minimum with no host version is refused, not skipped', () => {
  const row = { ...descriptor, minimum_host_version: '2026.12.1', earlier_releases: [{ ...descriptor, minimum_host_version: '2026.9.28' }] };
  assert.equal(refuseHostVersion(row, '2026.11.20'), null);
  assert.match(refuseHostVersion({ ...descriptor, minimum_host_version: '2026.9.28' }, undefined), /did not say which host it runs on/);
});

test('publishTool refuses a release this host is too old for, and writes no listing', async () => {
  const db = database({ ...descriptor, minimum_host_version: '2026.12.1' });
  await assert.rejects(publishTool({ ...facts, tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client), /needs version 2026.12.1/);
  assert.equal(db.listings.length, 0);
});

test('a tool that names a licence class (licence:maker-own) publishes as before, with no licence facts', async () => {
  const db = database();
  const { listing } = await publishTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client);
  assert.equal(listing.status, 'published');
  assert.equal(db.listings.length, 1);
});

test('a tool that names neither a licence class nor a minimum publishes with no facts, exactly as before the guards', async () => {
  const plain = { ...descriptor };
  delete plain.licence_class;
  delete plain.placements;
  const db = database(plain);
  const { listing } = await publishTool({ tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client);
  assert.equal(listing.status, 'published');
  assert.equal(db.listings.length, 1);
});

test('publishTool publishes a release this host runs, when the host version is given', async () => {
  const db = database({ ...descriptor, minimum_host_version: '2026.9.28' });
  const { listing } = await publishTool({ ...facts, tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client);
  assert.equal(listing.status, 'published');
  assert.equal(db.listings.length, 1);
});
