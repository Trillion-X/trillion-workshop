// tools/use-your-tools-from-a-shell/test/command-paged-answers.test.mjs
//
// `example op` and `example call` (do-work/command.mjs) read an answer that comes as a byte_page to its last page:
// against a fake door that pages any operation, every page is asked under the one request key of the call with
// after_byte beside the input, the pages are joined and checked against their BLAKE3, and the whole answer is printed.
// A BLAKE3 that does not match, or pages that do not hold together, are refused. The BLAKE3 is the content-identity owner's.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, stateOf, CommandError, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const ORIGIN = 'http://127.0.0.1:8788';
const KEY = `nm_${'ab'.repeat(16)}`;
const home = () => mkdtempSync(join(tmpdir(), 'example-paged-'));
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };

/** An answer the size of the one measured on Workshop b5a1a01c (50,454 bytes): an engine answer too big for one reply. */
const bigAnswer = () => {
  const rows = [];
  for (let at = 0; JSON.stringify(rows).length < 50_300; at += 1) rows.push({ rule: `rule ${at}`, verdict: at % 3 ? 'kept' : 'broken', why: 'é…'.repeat(at % 7) });
  return Buffer.from(JSON.stringify({ tool: 'tool:any', exit_code: 0, result: { rows }, replayed: false }));
};

/**
 * A fake door that answers do_one_thing_in_my_account and pages any answer over `pageBytes`. `shape(page, args)` may change a
 * page before it is sent; `status(call)` may answer an HTTP status instead; `hash` is the BLAKE3 the door names. Every
 * call of the answer is kept in `seen`. A `call` first reads its tool's row (tools:list with `tool`, for the run's need,
 * do-work/command.mjs); that read is answered with a row that names no need and kept in `listed`, apart from the pages.
 */
function fakeDoor({ whole, pageBytes = Math.ceil(whole.length / 4), shape = page => page, status = () => 200, hash = makeHashCodeHexFromBytes(whole).slice(3) } = {}) {
  const seen = [];
  const listed = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const args = body.params.arguments;
    if (args.method === 'tools:list' && typeof args.input?.tool === 'string') {
      listed.push(args.input.tool);
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { id: args.input.tool }, content: [] } });
    }
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
  return { seen, listed, fetchImpl };
}

const run = (argv, door, folder = home()) => main([...argv, '--origin', ORIGIN], {
  env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: folder }),
  fetchImpl: door.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

test('the content identity the CLI checks byte pages with is BLAKE3', () => {
  assert.equal(makeHashCodeHexFromBytes(new TextEncoder().encode('abc')), '1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
});

test('example call reads every page of a byte-paged answer under one request key and prints the whole answer', async () => {
  const whole = bigAnswer();
  const door = fakeDoor({ whole });
  const printed = await run(['call', 'tool:check-against-a-persons-rules-and-verdicts', '{"person":"p"}'], door);
  assert.deepEqual(JSON.parse(printed), JSON.parse(whole.toString('utf8')));
  assert.equal(door.seen.length, 4);
  assert.deepEqual(door.listed, ['tool:check-against-a-persons-rules-and-verdicts'], 'the tool\'s row is read once, before the run');
  const keys = new Set(door.seen.map(row => row.args.request_key));
  assert.equal(keys.size, 1, 'every page is asked under the first call\'s key');
  assert.match([...keys][0], /^[0-9a-f-]{36}$/, 'with no --request-key, a fresh key');
  const quarter = Math.ceil(whole.length / 4);
  assert.deepEqual(door.seen.map(row => row.args.input.after_byte), [undefined, quarter, quarter * 2, quarter * 3]);
  for (const row of door.seen) {
    assert.equal(row.args.address, undefined, 'a call names its method, not an address');
    assert.equal(row.args.method, 'tools:run');
    assert.equal(row.args.input.tool, 'tool:check-against-a-persons-rules-and-verdicts');
    assert.deepEqual(row.args.input.input, { person: 'p' });
  }
});

test('a job row too large for one reply is read whole, so a move names the claim the row holds', async () => {
  const target = { type: 'ai-job', id: 'ai-job:big' };
  const row = { id: 'ai-job:big', status: 'taken', taker: 'ai:lane-x', taken_at: '2026-11-15T20:00:00.000Z', label: 'A long brief', job: 'long brief words '.repeat(600), acceptance: { outcome: 'A long brief', target, rules: [] } };
  const whole = Buffer.from(JSON.stringify({ exit_code: 0, replayed: false, result: { jobs: [row], more: false, job_id: 'ai-job:big', moved: true, from: 'taken', to: 'done', job: row } }));
  const door = fakeDoor({ whole, pageBytes: 4000 });
  const folder = home();
  const accept = join(folder, 'acceptance.json');
  writeFileSync(accept, JSON.stringify({ outcome: 'A long brief', target, rules: [] }));
  await run(['plan', 'ai-job:big', '--acceptance-file', accept, '--as', 'lane-x'], door, folder);
  const planned = door.seen.find(row => row.args.input.tool === 'tool:change-an-ai-job' && row.args.input.after_byte === undefined);
  assert.equal(planned.args.input.input.taken_at, '2026-11-15T20:00:00.000Z', 'the claim is read from the whole row, not left out because the row came in pages');
});

test('example op pages any operation the same way, with nothing particular to one tool', async () => {
  const whole = Buffer.from(JSON.stringify({ value: 'x'.repeat(9000) }));
  const door = fakeDoor({ whole, pageBytes: 4000 });
  const printed = await run(['op', 'wake:list', '{"kind":"due-time"}'], door);
  assert.deepEqual(JSON.parse(printed), { value: 'x'.repeat(9000) });
  assert.equal(new Set(door.seen.map(row => row.args.request_key)).size, 1, 'every page is asked under one key');
  assert.deepEqual(door.seen.map(row => [row.args.input.after_byte, row.args.input.kind]),
    [[undefined, 'due-time'], [4000, 'due-time'], [8000, 'due-time']]);
});

test('an answer that is not JSON is printed as its text', async () => {
  const whole = Buffer.from('plain words '.repeat(500));
  const door = fakeDoor({ whole, pageBytes: 2500 });
  assert.equal(await run(['op', 'thing:read', '{}'], door), whole.toString('utf8'));
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
    assert.ok(error instanceof CommandError);
    assert.equal(error.status, 4);
    assert.ok(error.message.startsWith(settings.words.byte_page_mismatch));
    assert.match(error.detail, new RegExp(`joined ${whole.length} bytes have BLAKE3 ${makeHashCodeHexFromBytes(whole).slice(3)}, not f{64}`));
    return true;
  });
  assert.equal(door.seen.length, 4, 'every page was read before the check');
});

test('a page whose bytes were changed is refused by the BLAKE3', async () => {
  const whole = bigAnswer();
  const door = fakeDoor({ whole, shape: page => (page.offset ? { ...page, base64: Buffer.from(Buffer.from(page.base64, 'base64').map(byte => byte ^ 1)).toString('base64') } : page) });
  await assert.rejects(run(['call', 'tool:any', '{}'], door), error => error.message.startsWith(settings.words.byte_page_mismatch) && /have BLAKE3 [0-9a-f]{64}, not [0-9a-f]{64}/.test(error.detail));
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
  for (const [shape, words] of cases) await assert.rejects(run(['call', 'tool:any', '{}'], fakeDoor({ whole, shape })), error => error.message.startsWith(settings.words.byte_page_broken) && words.test(error.detail));
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
