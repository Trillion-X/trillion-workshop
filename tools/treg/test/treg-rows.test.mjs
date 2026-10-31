// tools/treg: the rows keep their promises. The catalog reads carry no credential; every row that holds the token takes
// it only from a treg connection the input names and places it only in the X-Treg-Token header; a paid call cannot be
// asked without a cost ceiling, and the ceiling is the header treg reads; the endpoint id is a hole in treg's call path
// that cannot leave it; and no row carries a held value or names a person or an account of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = new URL('../tool-rows.json', import.meta.url);
const text = readFileSync(file, 'utf8');
const rows = new Map(JSON.parse(text).records.map(({ payload }) => [payload.id, payload]));
const row = id => { assert.ok(rows.has(id), `${id} is a row`); return rows.get(id); };
const holdsToken = payload => Array.isArray(payload.invoke.credential_injections);
const accountPattern = new RegExp(row('tool:call-a-treg-endpoint').input_schema.properties.account.pattern);

test('every row is an http row on treg over https', () => {
  for (const payload of rows.values()) {
    assert.equal(payload.invoke.kind, 'http', payload.id);
    assert.match(payload.invoke.url, /^https:\/\/treg\.to\//, payload.id);
  }
});

test('finding an endpoint and reading its price hold no credential and only read', () => {
  for (const id of ['tool:search-the-treg-catalog', 'tool:read-a-treg-endpoint-and-its-price']) {
    const payload = row(id);
    assert.equal(holdsToken(payload), false, `${id} holds no token`);
    assert.equal(payload.invoke.connection, undefined, `${id} takes no connection`);
    assert.equal(payload.invoke.method, 'GET', id);
    assert.equal(payload.read_only, true, id);
  }
});

test('a row that holds the token takes it from the treg connection the input names, into X-Treg-Token only', () => {
  const holding = [...rows.values()].filter(holdsToken);
  assert.deepEqual(holding.map(payload => payload.id).sort(),
    ['tool:call-a-treg-endpoint', 'tool:read-my-treg-balance', 'tool:read-my-treg-team']);
  for (const payload of holding) {
    assert.deepEqual(payload.invoke.connection, { vendor: 'treg', from_input: 'account' }, payload.id);
    assert.equal(payload.invoke.connection_id, undefined, `${payload.id} fixes no one account`);
    assert.deepEqual(payload.invoke.credential_injections,
      [{ field_id: 'api_key', placement: { kind: 'header', name: 'X-Treg-Token' } }], payload.id);
    assert.ok(payload.input_schema.required.includes('account'), `${payload.id} requires the account`);
    assert.equal(payload.input_schema.properties.account.pattern, accountPattern.source, `${payload.id} reads one account shape`);
  }
});

test('the account names only a treg connection', () => {
  for (const account of ['service_connection:treg', 'service_connection:treg:second-team']) assert.match(account, accountPattern);
  for (const account of ['service_connection:x', 'service_connection:treg-other', 'service_connection:treg:', 'service_connection:treg:a:b', 'treg'])
    assert.doesNotMatch(account, accountPattern);
});

test('a paid call cannot be asked without a cost ceiling, and the ceiling is the header treg reads', () => {
  const call = row('tool:call-a-treg-endpoint');
  assert.ok(call.input_schema.required.includes('max_cost_usd'));
  const ceiling = call.input_schema.properties.max_cost_usd;
  assert.equal(ceiling.type, 'number');
  assert.equal(ceiling.exclusiveMinimum, 0);
  assert.ok(Number.isFinite(ceiling.maximum));
  assert.deepEqual(call.invoke.headers['X-Treg-Route-Max-Cost'], { from: 'max_cost_usd' });
  assert.equal(call.read_only, false);
});

test('the call sends the catalog method with the endpoint inside treg\'s call path', () => {
  const call = row('tool:call-a-treg-endpoint');
  assert.equal(call.invoke.url, 'https://treg.to/call/{endpoint}');
  assert.deepEqual(call.invoke.method, { fill: { from: 'input', field: 'method' } });
  assert.deepEqual(call.input_schema.properties.method.enum, ['GET', 'POST']);
  const endpoint = new RegExp(call.input_schema.properties.endpoint.pattern);
  for (const id of ['dataforseo.web.backlinks.summary', 'treg.web.map', 'example-tool/v1/items']) assert.match(id, endpoint);
  for (const id of ['../orgs/1/balance', '/call/x', 'https://example.com', 'a b', 'tool/../up', '.hidden']) assert.doesNotMatch(id, endpoint);
});

test('no row carries a held value, a person or an account of its own', () => {
  assert.doesNotMatch(text, /@[a-z0-9-]+\.[a-z]/i, 'no email address');
  assert.doesNotMatch(text, /(?:Bearer|token)["\s:=]+[A-Za-z0-9_-]{20,}/, 'no token value');
  for (const payload of rows.values()) {
    for (const item of payload.invoke.credential_injections ?? []) {
      assert.equal(item.secret_name, undefined, `${payload.id} names no fixed secret`);
      assert.equal(item.value, undefined, `${payload.id} holds no value`);
    }
  }
});
