// tools/read-rows-from-a-rest-service/test/read-rows.test.mjs
//
// Synthetic only: a made-up project and rows. No real project URL or key appears here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectOrigin, filterPairs, readRows } from '../do-work/read-rows.mjs';

const PROJECT = 'https://example-project.example.test';
const DOMAINS = ['example.test'];
const SERVICE = { serviceKey: 'EXAMPLE-SERVICE-KEY' };

test('a project URL must be a bare https root under a named domain', () => {
  assert.equal(projectOrigin('https://example-project.example.test/', DOMAINS), PROJECT);
  assert.equal(projectOrigin('https://example.test', DOMAINS), 'https://example.test');
  assert.throws(() => projectOrigin('http://example-project.example.test', DOMAINS), /must be an https address/);
  assert.throws(() => projectOrigin('https://example-project.example.test/rest/v1', DOMAINS), /no path/);
  assert.throws(() => projectOrigin('example', DOMAINS), /not a web address/);
  assert.throws(() => projectOrigin('https://other.test', DOMAINS), /key is not sent anywhere else/);
  assert.throws(() => projectOrigin('https://notexample.test', DOMAINS), /key is not sent anywhere else/);
  assert.throws(() => projectOrigin('https://example.test.other.test', DOMAINS), /key is not sent anywhere else/);
});

test('the shipped domains name Supabase projects only', () => {
  assert.equal(projectOrigin('https://example-project.supabase.co'), 'https://example-project.supabase.co');
  assert.throws(() => projectOrigin('https://example-project.example.test'), /key is not sent anywhere else/);
});

test('filters take only plain columns and known operators', () => {
  assert.deepEqual(filterPairs({ status: 'eq.active', age: 'gte.18' }), [['status', 'eq.active'], ['age', 'gte.18']]);
  assert.throws(() => filterPairs({ 'a;drop': 'eq.x' }), /not a plain column name/);
  assert.throws(() => filterPairs({ status: 'drop.active' }), /must start with one of/);
});

test('a read sends one GET to the project with the key as apikey and Bearer, and answers the rows and the total', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: new URL(url), init });
    return new Response(JSON.stringify([{ id: 1, name: 'Example Member' }]), { status: 200, headers: { 'content-range': '0-0/11' } });
  };
  const answer = await readRows({ project_url: 'https://example-project.supabase.co', table: 'members', select: 'id,name', limit: 5, filters: { status: 'eq.active' }, order: 'id.asc' }, { service: SERVICE, fetchImpl });
  assert.deepEqual(answer, { rows: [{ id: 1, name: 'Example Member' }], count: 1, total: 11 });
  assert.equal(seen[0].url.origin, 'https://example-project.supabase.co');
  assert.equal(seen[0].url.pathname, '/rest/v1/members');
  assert.equal(seen[0].url.searchParams.get('select'), 'id,name');
  assert.equal(seen[0].url.searchParams.get('limit'), '5');
  assert.equal(seen[0].url.searchParams.get('status'), 'eq.active');
  assert.equal(seen[0].url.searchParams.get('order'), 'id.asc');
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.apikey, 'EXAMPLE-SERVICE-KEY');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer EXAMPLE-SERVICE-KEY');
});

test('a refused key names the reconnect step and a missing key refuses before any request', async () => {
  const refused = async () => new Response('', { status: 401 });
  await assert.rejects(readRows({ project_url: 'https://example-project.supabase.co', table: 'members' }, { service: SERVICE, fetchImpl: refused }), /Connect the service again/);
  const never = async () => { throw new Error('no request should be made'); };
  await assert.rejects(readRows({ project_url: 'https://example-project.supabase.co', table: 'members' }, { service: { ...SERVICE, serviceKey: '' }, fetchImpl: never }), /No service key/);
});
