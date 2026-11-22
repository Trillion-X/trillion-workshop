// The Hetzner DNS provider promise: every request goes to api.hetzner.cloud, holds only the hetzner-api-token handle, and the zone and record parts name requests the file declares.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const provider = JSON.parse(readFileSync(new URL('../providers/hetzner-dns.json', import.meta.url), 'utf8'));

test('the Hetzner DNS provider names its base, bearer auth and vault handle, and no secret value', () => {
  assert.equal(provider.id, 'hetzner-dns');
  assert.equal(provider.base, 'https://api.hetzner.cloud/v1');
  assert.equal(provider.vault_key, 'hetzner-api-token');
  assert.deepEqual(provider.auth, { header: 'authorization', prefix: 'Bearer ' });
  assert.doesNotMatch(JSON.stringify(provider), /[A-Za-z0-9_-]{40,}/, 'no long token-shaped value in the file');
});

test('every request is an https call under the Hetzner base, with a method and a url', () => {
  for (const [name, request] of Object.entries(provider.requests)) {
    assert.ok(request.url.startsWith(`${provider.base}/zones`), name);
    assert.ok(['GET', 'POST', 'DELETE'].includes(request.method), name);
    assert.ok(request.notes, `${name} says what it does`);
  }
});

test('the zone and record parts name only requests the file declares', () => {
  const declared = new Set(Object.keys(provider.requests));
  for (const key of ['find', 'create', 'read']) assert.ok(declared.has(provider.zone[key]), `zone.${key}`);
  for (const key of ['list', 'create', 'add', 'remove']) assert.ok(declared.has(provider.record[key]), `record.${key}`);
});

test('the read-only requests send GET only; the change requests are POST or DELETE', () => {
  const reads = ['list_zones', 'find_zone', 'read_zone', 'list_records'];
  for (const name of reads) assert.equal(provider.requests[name].method, 'GET', name);
  for (const name of ['create_zone', 'create_record', 'add_record', 'remove_record']) assert.equal(provider.requests[name].method, 'POST', name);
});

test('a new A record is written with the shortest TTL the provider takes', () => {
  assert.equal(provider.requests.create_record.body_template.ttl, 60);
  assert.equal(provider.requests.create_zone.body_template.ttl, 60);
});
