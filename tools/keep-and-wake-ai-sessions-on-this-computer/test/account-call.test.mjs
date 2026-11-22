// test/account-call.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runOperation, opArguments, operationCaller, runDoor, AccountCallError } from '../harness/account-call.mjs';

const SIGN_IN = { credential: { from: 'kept sign-in', command: ['fake-command'] }, pins: ['f596fa0076f6c620'], timeout_seconds: 5 };
const KEYED = { credential: { from: 'keychain', item: 'test-key-item', origin: 'https://account.example' }, pins: ['f596fa0076f6c620'], timeout_seconds: 5 };
const SECRET = 'nm_test_secret_value_not_real';

// A fake command: its standard output and error are given, and it closes with `code` once its input is read.
function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false, seen = [] } = {}) {
  return (program, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    child.stdin = { end: text => { seen.push({ program, args, options, input: text }); if (!hang) setImmediate(() => { child.stdout.emit('data', stdout); child.stderr.emit('data', stderr); child.emit('close', code); }); } };
    return child;
  };
}

// A fake account door: it answers each request with `body` (JSON or an event stream), and records what it was sent.
function fakeFetch({ body = '', status = 200, sent = [], fail = null } = {}) {
  return async (url, init) => {
    sent.push({ url, init });
    if (fail) throw fail;
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
}
const okReply = result => JSON.stringify({ jsonrpc: '2.0', id: 'r', result: { structuredContent: result } });

test('the kept sign-in sends one pinned operation as the person: the command, the operation, its address, json and every pin; the input on standard input', async () => {
  const seen = [];
  const answer = await runOperation({ account: SIGN_IN, env: { PATH: '/bin' }, address: '@tools', method: 'tools:run', input: { tool: 'a' }, requestKey: 'rk-9', spawnImpl: fakeSpawn({ stdout: '{"exit_code":0}', seen }) });
  assert.deepEqual(answer, { exit_code: 0 });
  assert.equal(seen[0].program, 'fake-command');
  assert.deepEqual(seen[0].args, ['op', 'tools:run', '-', '--address', '@tools', '--json', '--pin', 'f596fa0076f6c620', '--request-key', 'rk-9']);
  assert.deepEqual(JSON.parse(seen[0].input), { tool: 'a' });
  assert.deepEqual(seen[0].options.env, { PATH: '/bin' });
});

test('no pin, or no address or method, is refused before anything is sent or started', async () => {
  const seen = [];
  assert.throws(() => opArguments({ method: 'm', address: '@tools', pins: [] }), { code: 'pin_absent' });
  assert.throws(() => opArguments({ method: '', address: '@tools', pins: ['f596fa0076f6c620'] }), { code: 'operation_incomplete' });
  await assert.rejects(runOperation({ account: { ...SIGN_IN, pins: [] }, address: '@tools', method: 'm', spawnImpl: fakeSpawn({ seen }) }), { code: 'pin_absent' });
  await assert.rejects(runOperation({ account: KEYED, address: undefined, method: 'm', fetchImpl: fakeFetch({ sent: [] }), readKey: () => SECRET }), { code: 'operation_incomplete' });
  assert.equal(seen.length, 0);
});

test('a refusal from the sign-in command is raised with the engine\'s own code and words', async () => {
  const stderr = '{"code":"tools_tool_unknown","message":"No tool has this id on this computer."}';
  await assert.rejects(runOperation({ account: SIGN_IN, address: '@tools', method: 'tools:run', spawnImpl: fakeSpawn({ stderr, code: 1 }) }), error => {
    assert.ok(error instanceof AccountCallError);
    assert.equal(error.code, 'tools_tool_unknown');
    assert.equal(error.message, 'No tool has this id on this computer.');
    return true;
  });
});

test('error output that is not the engine\'s JSON is said as its words, cut short', async () => {
  await assert.rejects(runOperation({ account: SIGN_IN, address: '@tools', method: 'm', spawnImpl: fakeSpawn({ stderr: 'boom '.repeat(400), code: 2 }) }), error => { assert.equal(error.code, 'failed'); assert.ok(error.message.length <= 800); return true; });
});

test('an operation that does not finish in time is stopped and raised as a timeout', async () => {
  await assert.rejects(runOperation({ account: { ...SIGN_IN, timeout_seconds: 0.05 }, address: '@tools', method: 'm', spawnImpl: fakeSpawn({ hang: true }) }), { code: 'timeout' });
});

test('an answer from the sign-in command that is not JSON is refused as unreadable', async () => {
  await assert.rejects(runOperation({ account: SIGN_IN, address: '@tools', method: 'm', spawnImpl: fakeSpawn({ stdout: 'not json', code: 0 }) }), { code: 'unreadable' });
});

test('the kept key sends the pinned operation to the account door, the key only in the Authorization header', async () => {
  const sent = [];
  const answer = await runOperation({ account: KEYED, address: '@tools', method: 'tools:run', input: { tool: 'a' }, requestKey: 'rk-3', fetchImpl: fakeFetch({ body: okReply({ exit_code: 0 }), sent }), readKey: item => (item === 'test-key-item' ? SECRET : null) });
  assert.deepEqual(answer, { exit_code: 0 });
  assert.equal(sent[0].url, 'https://account.example/mcp');
  assert.equal(sent[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(sent[0].init.headers.accept, 'application/json, text/event-stream');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.params.name, 'do_one_thing_in_my_account');
  assert.deepEqual(body.params.arguments, { address: '@tools', method: 'tools:run', input: { tool: 'a' }, request_key: 'rk-3', pins: ['f596fa0076f6c620'] });
  assert.equal(sent[0].init.body.includes(SECRET), false);
});

test('the keyed source reads an event-stream answer and raises the engine\'s refusal', async () => {
  const stream = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'r', result: { isError: true, content: [{ type: 'text', text: 'The rule does not allow it.' }] } })}\n\n`;
  await assert.rejects(runOperation({ account: KEYED, address: '@tools', method: 'm', fetchImpl: fakeFetch({ body: stream }), readKey: () => SECRET }), error => { assert.equal(error.code, 'refused'); assert.equal(error.message, 'The rule does not allow it.'); return true; });
});

test('the keyed source refuses a missing key, a non-https address and an HTTP error by name', async () => {
  await assert.rejects(runOperation({ account: KEYED, address: '@tools', method: 'm', fetchImpl: fakeFetch(), readKey: () => null }), { code: 'key_absent' });
  await assert.rejects(runOperation({ account: { ...KEYED, credential: { ...KEYED.credential, origin: 'http://example.com' } }, address: '@tools', method: 'm', fetchImpl: fakeFetch(), readKey: () => SECRET }), { code: 'origin_refused' });
  await assert.rejects(runOperation({ account: KEYED, address: '@tools', method: 'm', fetchImpl: fakeFetch({ status: 406 }), readKey: () => SECRET }), { code: 'http_status' });
});

test('an unknown source is refused by name, never guessed', async () => {
  await assert.rejects(runOperation({ account: { credential: { from: 'something else' }, pins: ['f596fa0076f6c620'] }, address: '@tools', method: 'm' }), { code: 'credential_unknown' });
});

test('the caller the runner uses answers a resource call through the account source, and legacy routes are refused', async () => {
  const seen = [];
  const call = operationCaller(SIGN_IN, { spawnImpl: fakeSpawn({ stdout: '{"ok":1}', seen }) });
  assert.deepEqual(await call.resource('@own-records', 'records:read', { id: 'a' }, 'rk'), { ok: 1 });
  assert.equal(seen[0].args[seen[0].args.indexOf('--request-key') + 1], 'rk');
  assert.throws(() => call('/handoffs/read'), { code: 'legacy_route' });
});

test('the modules hold no key of their own: the key appears only in the keyed source, read by its item name', () => {
  const text = readFileSync(new URL('../harness/account-call.mjs', import.meta.url), 'utf8');
  assert.equal(/nm_|sk_|secret\s*=/.test(text), false);
  assert.match(text, /authorization: `Bearer \$\{bearer\}`/);
});

// A run door: the descriptor the engine wrote, as `readDescriptor` answers it. Each test reads its own descriptor number,
// since a door is read once per descriptor and kept for the process.
const CAPABILITY = 'run_test_capability_not_real';
const DOOR_TEXT = JSON.stringify({ url: 'http://127.0.0.1:47011/mcp', resource: '@own-records', capability: CAPABILITY });
const doorAccount = fd => ({ credential: { from: 'run door', fd }, pins: ['f596fa0076f6c620'], timeout_seconds: 5 });

test('the run door sends the operation to the run\'s own route, the capability only in the Authorization header and no pin', async () => {
  const sent = [];
  const reads = [];
  const readDescriptor = fd => { reads.push(fd); return DOOR_TEXT; };
  const answer = await runOperation({ account: doorAccount(41), address: '@tools', method: 'tools:run', input: { tool: 'tool:take-a-task' }, requestKey: 'rk-door', fetchImpl: fakeFetch({ body: okReply({ taken: null }), sent }), readDescriptor });
  assert.deepEqual(answer, { taken: null });
  assert.equal(sent[0].url, 'http://127.0.0.1:47011/mcp');
  assert.equal(sent[0].init.headers.authorization, `Bearer ${CAPABILITY}`);
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.params.arguments, { address: '@tools', method: 'tools:run', input: { tool: 'tool:take-a-task' }, request_key: 'rk-door' });
  assert.equal(sent[0].init.body.includes(CAPABILITY), false);
  // The descriptor is a pipe written once: a second operation uses the door already read.
  await runOperation({ account: doorAccount(41), address: '@tools', method: 'tools:run', fetchImpl: fakeFetch({ body: okReply({}) }), readDescriptor });
  assert.deepEqual(reads, [41]);
});

test('the run door gives a request key longer than the door takes its own fixed-length name', async () => {
  const sent = [];
  const long = 'k'.repeat(300);
  await runOperation({ account: doorAccount(42), address: '@tools', method: 'tools:run', requestKey: long, fetchImpl: fakeFetch({ body: okReply({}), sent }), readDescriptor: () => DOOR_TEXT });
  const key = JSON.parse(sent[0].init.body).params.arguments.request_key;
  assert.match(key, /^key:[0-9a-f]+:[0-9a-f]{64}$/);
  assert.notEqual(key, long);
});

test('a run with no door, a door that is not this computer\'s loopback route, or no pin is refused before anything is sent', async () => {
  const sent = [];
  await assert.rejects(runOperation({ account: doorAccount(43), address: '@tools', method: 'm', fetchImpl: fakeFetch({ sent }), readDescriptor: () => { throw new Error('EBADF'); } }), { code: 'door_absent' });
  await assert.rejects(runOperation({ account: doorAccount(44), address: '@tools', method: 'm', fetchImpl: fakeFetch({ sent }), readDescriptor: () => '{"url":"http://127.0.0.1:1/mcp"}' }), { code: 'door_absent' });
  await assert.rejects(runOperation({ account: doorAccount(45), address: '@tools', method: 'm', fetchImpl: fakeFetch({ sent }), readDescriptor: () => JSON.stringify({ url: 'https://account.example/mcp', capability: CAPABILITY }) }), { code: 'origin_refused' });
  await assert.rejects(runOperation({ account: { ...doorAccount(46), pins: [] }, address: '@tools', method: 'm', fetchImpl: fakeFetch({ sent }), readDescriptor: () => DOOR_TEXT }), { code: 'pin_absent' });
  assert.throws(() => runDoor(2, () => DOOR_TEXT), { code: 'door_absent' });
  assert.equal(sent.length, 0);
});

// An answer too large for one reply comes as byte pages (src/mcp.rs); the account road joins them for every caller, so a
// task listing is rows again (the always-on's taker read every listing as a page and took nothing from 3:57 AM Nov 22 2026).
import { wholeAnswer } from '../harness/account-call.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const pagesOf = (value, size) => {
  const bytes = Buffer.from(JSON.stringify(value));
  const blake3 = makeHashCodeHexFromBytes(bytes).slice(3);
  const page = offset => {
    const part = bytes.subarray(offset, offset + size);
    const end = offset + part.length;
    return { byte_page: { total: bytes.length, blake3, offset, length: part.length, base64: part.toString('base64'), next_after_byte: end < bytes.length ? end : null } };
  };
  return { first: page(0), page };
};

test('a paged answer is joined into the whole answer, each further page asked with after_byte', async () => {
  const rows = { rows: Array.from({ length: 40 }, (_, i) => ({ id: `record:calendar-task:${i}`, title: `Task ${i}` })) };
  const { first, page } = pagesOf(rows, 97);
  const asked = [];
  assert.deepEqual(await wholeAnswer(first, async at => { asked.push(at); return page(at); }, 'tools:run'), rows);
  assert.ok(asked.length > 5);
  assert.deepEqual(asked, asked.map((_, i) => (i + 1) * 97), 'each page is asked where the last one ended');
  assert.deepEqual(await wholeAnswer({ rows: [] }, async () => { throw new Error('never asked'); }), { rows: [] }, 'an answer that is not paged is as it came');
});

test('pages that do not join are refused, never answered in part', async () => {
  const { first, page } = pagesOf({ rows: [1, 2, 3, 4, 5, 6, 7, 8] }, 5);
  await assert.rejects(wholeAnswer(first, async at => page(at + 1)), { code: 'byte_page_broken' });
  await assert.rejects(wholeAnswer(first, async () => ({ rows: [] })), { code: 'byte_page_broken' });
  const other = pagesOf({ rows: [9, 9, 9, 9, 9, 9, 9, 9] }, 5);
  await assert.rejects(wholeAnswer(first, async at => other.page(at)), { code: 'byte_page_broken' });
});

test('operationCaller hands every operation\'s pages back joined, under one request key', async () => {
  const rows = { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const { first, page } = pagesOf(rows, 10);
  const keys = [];
  const answers = [];
  const runOperationAt = async ({ input, requestKey }) => { keys.push(requestKey); answers.push(input.after_byte ?? 0); return input.after_byte === undefined ? first : page(input.after_byte); };
  assert.deepEqual(await wholeAnswer(await runOperationAt({ input: {}, requestKey: 'k1' }), at => runOperationAt({ input: { after_byte: at }, requestKey: 'k1' })), rows);
  assert.ok(keys.every(key => key === 'k1'));
  assert.equal(answers[0], 0);
});
