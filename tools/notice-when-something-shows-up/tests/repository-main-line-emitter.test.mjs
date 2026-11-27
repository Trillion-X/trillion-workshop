// The real repository leaf, resident projection and engine carrier over fixture-only compare and door answers.
// No socket, process, credential, database or live wake is reached.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runResidentEmitter } from '../do-work/emit-arrival-fact.mjs';
import { engineCarrier } from '../do-work/tell-the-engine.mjs';
import * as repository from '../do-work/mechanisms/repository-main-line.mjs';

const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const tool = rows.records.find(row => row.payload?.id === 'tool:notice-when-something-shows-up').payload;
const mainLine = tool.wakes.find(wake => wake.id === 'keep-noticing-main-line').input.waiters;
const replays = tool.wakes.find(wake => wake.id === 'replay-main-line-edge-cases').input.waiters;
const original = replays[0];
const file = (filename, status, deletions = 0, previous_filename) => ({ filename, status, deletions,
  ...(previous_filename ? { previous_filename } : {}) });

async function emitRow(row, files) {
  const sent = [];
  const compared = [];
  const carrier = engineCarrier({
    door: { url: 'http://fixture.invalid/mcp', capability: 'fixture-only' },
    waiters: [row],
    say: () => {},
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body).params.arguments);
      return new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
    },
  });
  const leaf = { ...repository, watchForTransitions: (settings, handlers) => repository.watchForTransitions(settings, {
    ...handlers,
    fetch: async url => {
      compared.push(url);
      return { ok: true, status: 200, json: async () => ({ files, total_commits: 1,
        commits: [{ commit: { committer: { date: '2026-11-24T06:00:00Z' } } }] }) };
    },
  }) };
  await runResidentEmitter({ env: {}, carrier, nowMs: () => 1795500000000,
    loadModule: async name => { assert.equal(name, 'repository-main-line.mjs'); return leaf; } });
  assert.equal(compared.length, 1);
  const own = repository.readSettings(row.mechanism_settings);
  assert.equal(compared[0], `${own.api_base}/repos/${own.repository}/compare/${own.replay.from}...${own.replay.to}`);
  return { sent, carrier, row };
}

async function emit({ source, files }) {
  const row = structuredClone(original);
  row.id = `waiter:${source}`;
  // The resident owner takes the source from the waiter row, not a leaf's detail fields.
  row.where = source;
  row.mechanism_settings = { ...row.mechanism_settings, repository: 'proof-owner/proof-repository', where: source,
    replay: { from: 'proof-base', to: 'proof-head' } };
  return emitRow(row, files);
}

test('the main-line and seven original replay waiters declare the source at the resident boundary', () => {
  assert.equal(mainLine.length, 1);
  assert.equal(replays.length, 7);
  for (const row of [...mainLine, ...replays]) {
    const own = repository.readSettings(row.mechanism_settings);
    assert.equal(row.where, own.where, `${row.id} must declare its source on the waiter, without changing its replay key`);
  }
});

test('the original replay row reaches the carrier with its declared source and unchanged event identity', async () => {
  const row = structuredClone(original);
  const own = repository.readSettings(row.mechanism_settings);
  const { sent, carrier } = await emitRow(row, [file('tools/from-old/capability.rs', 'removed', 80)]);
  assert.equal(sent.length, 1);
  const fact = sent[0].input;
  assert.equal(fact.payload.where, own.where);
  assert.equal(fact.event_id, `${row.emitted_record.address_label}@${own.where}:${own.branch}:${own.replay.to}`);
  assert.equal(fact.payload.key, own.replay.to);
  assert.deepEqual(JSON.parse(fact.payload.before), { base: own.replay.from });
  assert.deepEqual(JSON.parse(fact.payload.kinds), ['old-code-parked', 'old-code-removed']);
  assert.equal((await carrier.readCurrent(row.emitted_record.address_label, row.id)).state.head, own.replay.to);
});

const cases = [
  { source: 'proof-rust-removal', files: [file('src/parser.rs', 'removed', 70)], kinds: ['old-code-removed'] },
  { source: 'proof-screen-park', files: [file('web/from-old/screen.tsx', 'renamed', 0, 'web/screen.tsx')], kinds: ['old-code-parked'] },
  { source: 'proof-two-binary-files', files: [file('assets/a.bin', 'removed'), file('assets/b.bin', 'removed')], kinds: ['old-code-removed'] },
  { source: 'proof-mixed-park', files: [file('tools/from-old/a.mjs', 'removed', 50), file('tools/new.mjs', 'added')], kinds: ['old-code-parked', 'old-code-removed'] },
  { source: 'proof-small-edit', files: [file('src/keep.rs', 'modified', 3)], kinds: [] },
  { source: 'proof-additions', files: [file('web/new.tsx', 'added')], kinds: [] },
  { source: 'proof-ordinary-rename', files: [file('src/new.rs', 'renamed', 0, 'src/old.rs')], kinds: [] },
];

for (const one of cases) {
  test(`${one.source}: the leaf, resident and carrier preserve the source and threshold result`, async () => {
    const { sent, carrier, row } = await emit(one);
    if (!one.kinds.length) {
      assert.deepEqual(sent, []);
      assert.deepEqual(carrier.answer.told, []);
      return;
    }
    assert.equal(sent.length, 1);
    const call = sent[0];
    assert.equal(call.method, 'wake:arrive');
    assert.equal(call.input.kind, 'something-changed');
    assert.equal(call.input.event_id, `where::something-changed@${one.source}:main:proof-head`);
    const payload = call.input.payload;
    assert.deepEqual(Object.keys(payload), ['where', 'place', 'change', 'at', 'key', 'before', 'after', 'kinds']);
    assert.equal(payload.where, one.source);
    assert.equal(payload.key, 'proof-head');
    assert.equal(payload.change, 'moved');
    assert.deepEqual(JSON.parse(payload.kinds), one.kinds);
    assert.deepEqual(JSON.parse(payload.before), { base: 'proof-base' });
    const after = JSON.parse(payload.after);
    assert.equal(after.counts.files, one.files.length);
    assert.deepEqual(after.removed, one.files.filter(item => item.status === 'removed').map(item => item.filename));
    assert.deepEqual(after.moves, one.files.filter(item => item.status === 'renamed')
      .map(item => ({ old: item.previous_filename, new: item.filename })));
    assert.equal((await carrier.readCurrent(row.emitted_record.address_label, row.id)).state.head, 'proof-head');
    assert.equal(carrier.answer.refused.length, 0);
  });
}

test('a long real projection keeps its source, kinds and lower-bound counts while cutting paths to one field', async () => {
  const files = Array.from({ length: 300 }, (_, index) => file(`tools/from-old/${'x'.repeat(60)}-${index}.mjs`, 'removed', 2));
  const { sent } = await emit({ source: 'proof-large-removal', files });
  assert.equal(sent.length, 1);
  const payload = sent[0].input.payload;
  assert.equal(payload.where, 'proof-large-removal');
  assert.ok(Buffer.byteLength(payload.after) <= repository.FIELD_BYTES);
  const after = JSON.parse(payload.after);
  assert.equal(after.cut, true);
  assert.equal(after.counts.files, 300);
  assert.equal(after.counts.removed_lines, 600);
  assert.equal(after.counts.truncated, true);
  assert.deepEqual(JSON.parse(payload.kinds), ['old-code-parked', 'old-code-removed']);
});
