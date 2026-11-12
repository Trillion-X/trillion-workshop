// tools/use-trillion-from-a-shell/test/trillion-paged-answers.test.mjs
//
// `trillion op` and `trillion call` (do-work/trillion.mjs) read an answer that comes as a byte_page to its last page:
// against a fake door that pages any operation, every page is asked under the one request key of the call with
// after_byte beside the input, the pages are joined and checked against their BLAKE3, and the whole answer is printed.
// A BLAKE3 that does not match, or pages that do not hold together, are refused. The BLAKE3 is the content-identity owner's.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { main, stateOf, TrillionError } from '../do-work/trillion.mjs';

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'ab'.repeat(16)}`;
const home = () => mkdtempSync(join(tmpdir(), 'trillion-paged-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };

/** An answer the size of the one measured on Workshop b5a1a01c (50,454 bytes): an engine answer too big for one reply. */
const bigAnswer = () => {
  const rows = [];
  for (let at = 0; JSON.stringify(rows).length < 50_300; at += 1) rows.push({ rule: `rule ${at}`, verdict: at % 3 ? 'kept' : 'broken', why: 'é…'.repeat(at % 7) });
  return Buffer.from(JSON.stringify({ tool: 'tool:any', exit_code: 0, result: { rows }, replayed: false }));
};

/**
 * A fake door that answers run_resource_operation and pages any answer over `pageBytes`. `shape(page, args)` may change a
 * page before it is sent; `status(call)` may answer an HTTP status instead; `hash` is the BLAKE3 the door names. Every
 * call is kept in `seen`.
 */
function fakeDoor({ whole, pageBytes = Math.ceil(whole.length / 4), shape = page => page, status = () => 200, hash = makeHashCodeHexFromBytes(whole).slice(3) } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const args = body.params.arguments;
    seen.push({ url, args, authorization: init.headers.authorization });
    const code = status(seen.length);
    if (code !== 200) return new Response('busy', { status: code });
    const from = args.input.after_byte ?? 0;
    const length = Math.min(pageBytes, whole.length - from);
    const page = shape({ offset: from, length, total: whole.length, next_after_byte: from + length < whole.length ? from + length : null,
      blake3: hash, base64: whole.subarray(from, from + length).toString('base64') }, args);
    const answer = whole.length > pageBytes ? { byte_page: page } : JSON.parse(whole.toString('utf8'));
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: answer, content: [] } });
  };
  return { seen, fetchImpl };
}

const run = (argv, door, folder = home()) => main([...argv, '--origin', ORIGIN], {
  env: { TRILLION_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: folder }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

test('the packed content-identity library is the owner\'s own bytes, so the CLI checks the BLAKE3 the owner computes', () => {
  assert.deepEqual(readFileSync(new URL('../do-work/packs/read-data/identity.mjs', import.meta.url)), readFileSync(new URL('../../content-identity/read-data/identity.mjs', import.meta.url)));
  assert.equal(makeHashCodeHexFromBytes(new TextEncoder().encode('abc')), '1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
});

test('trillion call reads every page of a byte-paged answer under one request key and prints the whole answer', async () => {
  const whole = bigAnswer();
  const door = fakeDoor({ whole });
  const printed = await run(['call', 'tool:check-against-a-persons-rules-and-verdicts', '{"person":"p"}'], door);
  assert.deepEqual(JSON.parse(printed), JSON.parse(whole.toString('utf8')));
  assert.equal(door.seen.length, 4);
  const keys = new Set(door.seen.map(row => row.args.request_key));
  assert.equal(keys.size, 1, 'every page is asked under the first call\'s key');
  assert.match([...keys][0], /^[0-9a-f-]{36}$/, 'with no --request-key, a fresh key');
  const quarter = Math.ceil(whole.length / 4);
  assert.deepEqual(door.seen.map(row => row.args.input.after_byte), [undefined, quarter, quarter * 2, quarter * 3]);
  for (const row of door.seen) {
    assert.equal(row.args.address, '@workshop-tools');
    assert.equal(row.args.method, 'tools:run');
    assert.equal(row.args.input.tool, 'tool:check-against-a-persons-rules-and-verdicts');
    assert.deepEqual(row.args.input.input, { person: 'p' });
  }
});

test('trillion op pages any operation the same way, with nothing particular to one tool', async () => {
  const whole = Buffer.from(JSON.stringify({ value: 'x'.repeat(9000) }));
  const door = fakeDoor({ whole, pageBytes: 4000 });
  const printed = await run(['op', '@own-records', 'records:read', '{"id":"note:big"}'], door);
  assert.deepEqual(JSON.parse(printed), { value: 'x'.repeat(9000) });
  assert.equal(new Set(door.seen.map(row => row.args.request_key)).size, 1, 'every page is asked under one key');
  assert.deepEqual(door.seen.map(row => [row.args.input.after_byte, row.args.input.id]),
    [[undefined, 'note:big'], [4000, 'note:big'], [8000, 'note:big']]);
});

test('an answer that is not JSON is printed as its text', async () => {
  const whole = Buffer.from('plain words '.repeat(500));
  const door = fakeDoor({ whole, pageBytes: 2500 });
  assert.equal(await run(['op', '@any', 'thing:read', '{}'], door), whole.toString('utf8'));
});

test('an answer that fits one reply is printed as before, in one call', async () => {
  const door = fakeDoor({ whole: Buffer.from(JSON.stringify({ tool: 'tool:x', exit_code: 0, result: { ok: true } })), pageBytes: 10_000 });
  assert.deepEqual(JSON.parse(await run(['call', 'tool:x', '{}'], door)), { tool: 'tool:x', exit_code: 0, result: { ok: true } });
  assert.equal(door.seen.length, 1);
});

test('a BLAKE3 that does not match the joined pages is refused, and nothing is printed', async () => {
  const whole = bigAnswer();
  const door = fakeDoor({ whole, hash: 'f'.repeat(64) });
  await assert.rejects(run(['call', 'tool:any', '{}'], door), error => {
    assert.ok(error instanceof TrillionError);
    assert.equal(error.status, 4);
    assert.match(error.message, new RegExp(`joined ${whole.length} bytes have BLAKE3 ${makeHashCodeHexFromBytes(whole).slice(3)}, not the f{64}`));
    return true;
  });
  assert.equal(door.seen.length, 4, 'every page was read before the check');
});

test('a page whose bytes were changed is refused by the BLAKE3', async () => {
  const whole = bigAnswer();
  const door = fakeDoor({ whole, shape: page => (page.offset ? { ...page, base64: Buffer.from(Buffer.from(page.base64, 'base64').map(byte => byte ^ 1)).toString('base64') } : page) });
  await assert.rejects(run(['call', 'tool:any', '{}'], door), /have BLAKE3 [0-9a-f]{64}, not the/);
});

test('pages that do not hold together are refused before they are joined', async () => {
  const whole = bigAnswer();
  const quarter = Math.ceil(whole.length / 4);
  const cases = [
    [page => (page.offset ? { ...page, blake3: '0'.repeat(64) } : page), /belongs to another answer/],
    [page => (page.offset ? { ...page, total: page.total + 1 } : page), /belongs to another answer/],
    [page => (page.offset === quarter ? { ...page, offset: quarter + 1 } : page), /starts at byte/],
    [page => (page.offset === quarter ? { ...page, next_after_byte: null } : page), /next_after_byte is null/],
    [page => (page.offset === 0 ? { ...page, length: page.length + 1 } : page), /says \d+ bytes and holds/],
    [page => ({ ...page, blake3: 'not a hash' }), /no BLAKE3/],
  ];
  for (const [shape, words] of cases) await assert.rejects(run(['call', 'tool:any', '{}'], fakeDoor({ whole, shape })), words);
});

test('a page the door could not answer at once is asked again under the same key', async () => {
  const whole = bigAnswer();
  // The 2nd and 4th HTTP calls (the second page, then the third) answer 503 once each; the client sends them again.
  const door = fakeDoor({ whole, status: call => (call === 2 || call === 4 ? 503 : 200) });
  const printed = await run(['call', 'tool:any', '{}'], door);
  assert.deepEqual(JSON.parse(printed), JSON.parse(whole.toString('utf8')));
  assert.equal(door.seen.length, 6);
  assert.equal(new Set(door.seen.map(row => row.args.request_key)).size, 1, 'a retried page keeps the key');
  const quarter = Math.ceil(whole.length / 4);
  assert.deepEqual(door.seen.map(row => row.args.input.after_byte), [undefined, quarter, quarter, quarter * 2, quarter * 2, quarter * 3]);
});
