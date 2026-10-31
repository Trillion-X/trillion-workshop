// tools/treg: the rows keep their promises. The catalog reads carry no credential; every row that holds the token takes
// it only from a treg connection the input names and places it only in the X-Treg-Token header; a paid call cannot be
// asked without a cost ceiling, and the ceiling is the header treg reads; the endpoint id is a hole in treg's call path
// that cannot leave it; and no row carries a held value or names a person or an account of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

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
    ['tool:call-a-treg-endpoint', 'tool:read-a-treg-call', 'tool:read-my-treg-balance', 'tool:read-my-treg-team']);
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

test('a call is read back by its id, in treg\'s calls path only, and only read', () => {
  const read = row('tool:read-a-treg-call');
  assert.equal(read.invoke.url, 'https://treg.to/calls/{call_id}');
  assert.equal(read.invoke.method, 'GET');
  assert.equal(read.read_only, true);
  const id = new RegExp(read.input_schema.properties.call_id.pattern);
  assert.match('0123456789abcdef0123456789abcdef', id);
  for (const bad of ['../orgs/1/balance', '0123456789abcdef0123456789abcde', '0123456789abcdef0123456789abcdef/result', '12', 'G123456789abcdef0123456789abcdef']) assert.doesNotMatch(bad, id);
});

// A stand-in for treg on this computer, answering as treg's source does (src/treg/application/call/route.py and
// src/treg/api.py get_call): a generation submission answers 202 pending with its cost held, its call id and its task
// descriptor in headers; GET /calls/<id> answers the task pending, then settled with its result. Each request is made
// from the row's own DATA the way the engine places it (the URL's holes from the input, the token as the injection
// names), and each answer is { result, headers } as the engine's http kind returns it (headers in lower case).
const CALL_ID = '0123456789abcdef0123456789abcdef';
const TOKEN = 'made-up-token-value';
function standInTreg() {
  const asked = [];
  let reads = 0;
  const server = createServer((request, response) => {
    asked.push({ method: request.method, path: request.url, token: request.headers['x-treg-token'] });
    const reply = (status, body, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)); };
    if (request.method === 'POST' && request.url === '/call/made-up.video.generate') {
      return reply(202, { _treg: { outcome: 'pending' }, reserved_micro: 500000, charged_micro: null }, {
        'X-Treg-Cost-Micro': '500000', 'X-Treg-Call-Id': CALL_ID, 'X-Treg-Served-By': 'made-up.video.generate',
        'X-Treg-Async': JSON.stringify({ id_from: 'id', poll: { endpoint: 'made-up.tasks.get', param: { in: 'pathParams', name: 'id' } }, status: { path: 'status', success: ['succeeded'], failure: ['failed'] }, result: { path: 'output' }, interval: 2 }),
      });
    }
    if (request.method === 'GET' && request.url === `/calls/${CALL_ID}`) {
      reads += 1;
      const settled = reads >= 2;
      return reply(200, { call: { call_ref: CALL_ID, status_code: 202, cost_charged_micro: settled ? 420000 : 500000 }, async_task: { status: settled ? 'settled' : 'pending', reserved_micro: 500000, settled_micro: settled ? 420000 : null, result_url: settled ? 'https://media.example.test/made-up.mp4' : null }, ledger: [], charged_micro: settled ? 420000 : 0 });
    }
    return reply(404, { detail: 'no route' });
  });
  return new Promise(ready => server.listen(0, '127.0.0.1', () => ready({ asked, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) })));
}

// One run of an http row against the stand-in: the row's URL with its holes filled from the input, its method, its
// fixed headers and the token placed as its injection says.
async function run(id, input, origin) {
  const { invoke, result_selector: selector } = row(id);
  const url = invoke.url.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(input[name])).replace('https://treg.to', origin);
  const method = typeof invoke.method === 'string' ? invoke.method : input[invoke.method.fill.field];
  const headers = Object.fromEntries(Object.entries(invoke.headers).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value]] : input[value.from] === undefined ? [] : [[name, String(input[value.from])]])));
  for (const { placement } of invoke.credential_injections ?? []) headers[placement.name] = TOKEN;
  const response = await fetch(url, { method, headers, ...(input.body ? { body: JSON.stringify(input.body) } : {}) });
  assert.equal(selector, '$', `${id} answers the whole reply`);
  return { status: response.status, result: await response.json(), headers: Object.fromEntries([...response.headers].map(([name, value]) => [name.toLowerCase(), value])) };
}

test('a call\'s cost and id are read from its answer\'s headers, and its task is followed by reading the call until it settles', async () => {
  const treg = await standInTreg();
  try {
    const call = await run('tool:call-a-treg-endpoint', { account: 'service_connection:treg', endpoint: 'made-up.video.generate', method: 'POST', body: { prompt: 'A kite' }, max_cost_usd: 1 }, treg.origin);
    assert.equal(call.status, 202);
    assert.equal(call.result._treg.outcome, 'pending');
    assert.equal(Number(call.headers['x-treg-cost-micro']) / 1e6, 0.5, 'the amount held, in dollars');
    assert.equal(call.headers['x-treg-call-id'], CALL_ID);
    const descriptor = JSON.parse(call.headers['x-treg-async']);
    assert.deepEqual(descriptor.status.success, ['succeeded']);
    let read;
    do read = await run('tool:read-a-treg-call', { account: 'service_connection:treg', call_id: call.headers['x-treg-call-id'] }, treg.origin);
    while (read.result.async_task.status === 'pending');
    assert.equal(read.result.async_task.status, 'settled');
    assert.equal(read.result.async_task.result_url, 'https://media.example.test/made-up.mp4');
    assert.equal(read.result.charged_micro, 420000);
    assert.deepEqual(treg.asked.map(item => `${item.method} ${item.path}`), ['POST /call/made-up.video.generate', `GET /calls/${CALL_ID}`, `GET /calls/${CALL_ID}`], 'the call was sent once and then only read');
    assert.ok(treg.asked.every(item => item.token === TOKEN), 'each row placed the token in X-Treg-Token');
  } finally { await treg.close(); }
});
