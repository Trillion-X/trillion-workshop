// tools/list-and-run-my-tools-for-any-ai/test/publish-guards.test.mjs
//
// The two guards the old publishTool had and this owner lacked (src/workshop.mjs:1707 and :942, :1709-1710): a release that needs
// a newer host version, and a tool whose licence keeps it to each caller's own sandbox. Each is checked alone, then through publishTool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishTool, refuseHostVersion, refuseCallerOnly, compareVersions } from '../do-work/publish-tool.mjs';
import { savedAndListedDatabase } from './saved-and-listed-database.mjs';

const descriptor = {
  kind: 'ai-tool-descriptor', id: 'tool:echo-test', job: 'Echo the input text back',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  invoke: { kind: 'container', argv: ['python3', 'main.py'], workdir: '/work' },
  can_do: ['Echo the text back'], cannot_do: ['Send messages'],
  verify: [{ kind: 'sample-run', input: { text: 'hi' } }],
  licence_class: 'licence:maker-own', placements: ['placement:this-account'],
};
const files = Buffer.from('print(1)');
const licences = { 'licence:maker-own': { id: 'licence:maker-own', label: 'Maker-owned', allowed_placements: ['placement:this-account'] } };
const deployed = { 'placement:this-account': { id: 'placement:this-account', executor: 'container', reachable_from: ['host:test'] } };
const callerOnly = { 'placement:this-account': { id: 'placement:this-account', executor: 'caller', reachable_from: ['host:test'] } };
const facts = { host: 'host:test', host_version: '2026.11.20', licences, placements: deployed };
const database = () => savedAndListedDatabase({ saved: [{ id: 'tool:echo-test', descriptor, fingerprint: '1f:aa', files }] });

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

test('caller-only: a deployed placement passes; a placement only the caller runs is refused in the old words', () => {
  assert.equal(refuseCallerOnly(descriptor, facts), null);
  assert.equal(refuseCallerOnly(descriptor, { ...facts, placements: callerOnly }),
    'tool:echo-test\'s licence (Maker-owned) lets it run only in each caller\'s own sandbox, so it cannot be offered to everyone from here.');
});

test('caller-only: a licence the catalogue does not know, a placement not reachable from this host, and missing facts are each refused', () => {
  assert.equal(refuseCallerOnly({ ...descriptor, licence_class: 'licence:unknown' }, facts), 'tool:echo-test has no known licence class, so it cannot run anywhere yet.');
  assert.match(refuseCallerOnly(descriptor, { ...facts, host: 'host:elsewhere' }), /none of those can be reached from this service/);
  assert.match(refuseCallerOnly(descriptor, { host: 'host:test' }), /were not given/);
  assert.match(refuseCallerOnly({ ...descriptor, licence_class: undefined }, facts), /has no known licence class/);
});

test('publishTool refuses a caller-only tool and writes no listing', async () => {
  const db = database();
  await assert.rejects(publishTool({ ...facts, placements: callerOnly, tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client),
    error => /only in each caller's own sandbox/.test(error.message));
  assert.equal(db.listings.length, 0);
});

test('publishTool refuses a release this host is too old for, and writes no listing', async () => {
  const db = savedAndListedDatabase({ saved: [{ id: 'tool:echo-test', descriptor: { ...descriptor, minimum_host_version: '2026.12.1' }, fingerprint: '1f:aa', files }] });
  await assert.rejects(publishTool({ ...facts, tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client), /needs version 2026.12.1/);
  assert.equal(db.listings.length, 0);
});

test('publishTool publishes a deployed tool when the facts are given', async () => {
  const db = database();
  const { listing } = await publishTool({ ...facts, tool_id: 'tool:echo-test', maker: 'person:ana' }, db.client);
  assert.equal(listing.status, 'published');
  assert.equal(db.listings.length, 1);
});
