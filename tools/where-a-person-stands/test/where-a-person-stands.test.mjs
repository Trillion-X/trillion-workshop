// tools/where-a-person-stands: a stand is the person's own, kept as one record per kind and identity, and read back with
// their words whole and every earlier stand from that record's versions; a text is identified folded and anything else
// by its bytes; a reload plan writes earlier stands as earlier versions and shows what the fold merged; each row's sample
// runs as the tool container runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { artifactRef, bytesRef, foldWith, textRef, viewRef } from '../do-work/artifact-ref.mjs';
import { artifactOf, planReload, stanceChoices, stanceRecord, stanceRecordId, standsFrom } from '../do-work/where-a-person-stands.mjs';

const folder = resolve(import.meta.dirname, '..');
const IDENTITY = `1f:${'a'.repeat(64)}`;
const OTHER = `1f:${'b'.repeat(64)}`;
const FOLD = { lowercase: true, quotes: [['‘’', "'"], ['“”', '"']], collapse_space: true, strip_trailing: '[.!?]+' };
const said = { kind: 'file', artifact_ref: `file:${IDENTITY}`, answered_by: 'person' };

test('the fold runs lowercase, quotes, space, trim, then a trailing match, and is DATA', () => {
  const fold = foldWith(FOLD);
  assert.equal(fold('  “Why  Now?”  It’s HERE!!  '), '"why now?" it\'s here');
  assert.equal(fold('Start here. '), 'start here');
  assert.equal(foldWith({})('  As Typed. '), 'As Typed.');
  assert.throws(() => textRef('Start here'), /fold/);
});

test('a text is identified by BLAKE3 of its folded text, anything else by its bytes', () => {
  assert.equal(textRef('Start Here!', FOLD), textRef('start here', FOLD));
  assert.notEqual(textRef('Start there', FOLD), textRef('start here', FOLD));
  // BLAKE3 of the empty input and of "abc", the published test vectors.
  assert.equal(bytesRef(new Uint8Array()), '1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
  assert.equal(bytesRef(new TextEncoder().encode('abc')), '1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
  assert.equal(viewRef({ a: 1 }), bytesRef(new TextEncoder().encode('{"a":1}')));
  assert.equal(artifactRef({ text: 'x', view: { a: 1 } }, FOLD), viewRef({ a: 1 }));
  assert.equal(artifactRef({ contains: 'Start Here.' }, FOLD), textRef('start here', FOLD));
});

test('a stand names its thing by kind and identity, and a name or a short identity is refused', () => {
  assert.equal(artifactOf(`file:${IDENTITY}`), IDENTITY);
  assert.equal(stanceRecordId('file', `file:${IDENTITY}`), `stance:file:${IDENTITY}`);
  for (const named of ['/Content/probe/hello.txt', '1f:abc', `12:${'a'.repeat(64)}`, `1f:${'A'.repeat(64)}`, null]) {
    assert.throws(() => stanceRecord({ ...said, artifact_ref: named, stance: 'agree' }), /identity/, String(named));
  }
  assert.throws(() => stanceRecord({ ...said, kind: 'a/b', stance: 'agree' }), /kind/);
  assert.throws(() => stanceRecord({ kind: 'title', text: 'Start', answered_by: 'person', stance: 'agree' }), /fold/);
  const title = stanceRecord({ kind: 'title', text: 'Start Here.', fold: FOLD, answered_by: 'person', stance: 'agree' });
  assert.deepEqual([title.id, title.text], [`stance:title:${textRef('start here', FOLD)}`, 'Start Here.']);
});

test('only the person\'s own stand is kept, with their words exactly, and partly is a stand of its own', () => {
  assert.throws(() => stanceRecord({ ...said, answered_by: 'ai', stance: 'agree' }), /answered_by/);
  assert.throws(() => stanceRecord({ ...said, stance: 'love' }), /agree, disagree, partly/);
  const why = '  Fine for now,  but the opening is slow. ';
  const kept = stanceRecord({ ...said, stance: 'partly', why, at: '2026-01-01T12:00:00Z' });
  assert.deepEqual(kept, { type: 'stance', id: `stance:file:${IDENTITY}`, kind: 'file', artifact: IDENTITY, stance: 'partly',
    said: 'You partly agree with this.', why, by: 'person', at: '2026-01-01T12:00:00Z' });
  assert.deepEqual(stanceChoices().map(choice => choice.id), ['agree', 'disagree', 'partly']);
  const back = stanceRecord({ ...said, stance: null, why: 'ignored' });
  assert.deepEqual([back.stance, 'said' in back, 'why' in back], [null, false, false]);
});

test('the newest version is the stand, every older one is earlier, and silence or a stand taken back is no stand', () => {
  const versions = [
    stanceRecord({ ...said, stance: 'disagree', why: 'reads as generic', at: '2026-01-01T13:00:00Z' }),
    { value: stanceRecord({ ...said, stance: 'agree', why: 'good', at: '2026-01-01T11:00:00Z' }) },
    { payload: stanceRecord({ ...said, artifact_ref: OTHER, stance: 'agree', at: '2026-01-01T10:00:00Z' }) },
    { payload: stanceRecord({ ...said, kind: 'take', stance: 'agree', at: '2026-01-01T10:00:00Z' }) },
    { type: 'message', id: 'm', artifact: IDENTITY, stance: 'agree', at: '2026-01-01T23:00:00Z' },
  ];
  const [one, other, take] = standsFrom(versions);
  assert.deepEqual([one.artifact, one.kind, one.stance, one.why, one.at], [IDENTITY, 'file', 'disagree', 'reads as generic', '2026-01-01T13:00:00Z']);
  assert.deepEqual(one.earlier.map(item => [item.stance, item.why]), [['agree', 'good']]);
  assert.deepEqual([other.artifact, take.kind], [OTHER, 'take']);
  assert.deepEqual(standsFrom(versions, { artifact_ref: IDENTITY, kind: 'take' }).map(item => item.stance), ['agree']);
  const none = standsFrom(versions, { artifact_ref: `1f:${'c'.repeat(64)}` })[0];
  assert.deepEqual([none.stance, none.earlier], [null, []]);
  const takenBack = standsFrom([...versions, stanceRecord({ ...said, stance: null, at: '2026-01-02T09:00:00Z' })], { artifact_ref: IDENTITY, kind: 'file' })[0];
  assert.deepEqual([takenBack.stance, takenBack.earlier.length], [null, 2]);
});

test('a reload plan writes earlier stands first, oldest first, counts changed refs and shows what the fold merged', () => {
  const plan = planReload({ fold: FOLD, stances: [
    { kind: 'title', text: 'Start Here.', stance: 'agree', why: 'good', by: 'this browser', at: '2026-01-01T11:00:00Z',
      ref: `file:${IDENTITY}`, earlier: [{ stance: 'disagree', why: 'no', at: '2026-01-01T10:00:00Z' }] },
    { kind: 'title', text: 'Start  HERE?', stance: 'disagree', why: 'worse', at: '2026-01-01T13:00:00Z' },
    { kind: 'title', text: 'start here!', stance: 'partly', why: 'mid', at: '2026-01-01T09:00:00Z', ref: `file:${textRef('start here', FOLD)}` },
    { kind: 'onscreen', text: 'Start here', stance: 'agree', at: '2026-01-01T08:00:00Z' },
    { kind: 'stitch-plan', view: { segments: [] }, text: '{"segments":[]}', stance: 'disagree', why: 'too many questions', at: '2026-01-01T12:00:00Z' },
  ] });
  const id = `stance:title:${textRef('start here', FOLD)}`;
  const title = plan.writes.filter(write => write.id === id);
  assert.deepEqual(title.map(write => [write.value.stance, write.value.at]), [
    ['partly', '2026-01-01T09:00:00Z'], ['disagree', '2026-01-01T10:00:00Z'], ['agree', '2026-01-01T11:00:00Z'], ['disagree', '2026-01-01T13:00:00Z']]);
  assert.equal(title[1].value.by, 'this browser', 'an earlier stand keeps who it was said through');
  assert.deepEqual(plan.summary.by_kind.title, { records: 1, versions: 4, rows: 3 });
  assert.equal(plan.summary.refs_changed, 1, 'only the row whose old ref is not its folded identity');
  assert.deepEqual(plan.summary.collisions.map(item => [item.kind, item.rows.map(row => row.text)]),
    [['title', ['Start Here.', 'Start  HERE?', 'start here!']]]);
  assert.equal(plan.writes.find(write => write.value.kind === 'stitch-plan').value.artifact, viewRef({ segments: [] }));
  assert.deepEqual([plan.summary.rows, plan.summary.records, plan.summary.versions], [5, 3, 6]);
});

const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const at = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((node, key) => node?.[key], value);
const run = (argv, input) => spawnSync(process.execPath, argv, { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });

for (const row of rows) {
  test(`${row.id} answers its own sample on the last line`, () => {
    for (const sample of row.verify.filter(item => item.kind === 'sample-run')) {
      const ran = run(row.invoke.argv.slice(1), sample.input);
      assert.equal(ran.status, 0, ran.stderr);
      const answer = at(JSON.parse(ran.stdout.trim().split('\n').at(-1)), row.result_selector);
      assert.ok(String(at(answer, sample.output_selector)).includes(sample.contains), JSON.stringify(answer));
    }
  });
}

test('the kept record is the one keeps_records selects, with its type and id read from its own fields', () => {
  const keep = rows.find(row => row.id === 'tool:keep-where-you-stand');
  const ran = run(keep.invoke.argv.slice(1), { ...said, stance: 'agree', why: 'good', at: '2026-01-01T11:00:00Z' });
  const output = at(JSON.parse(ran.stdout.trim().split('\n').at(-1)), keep.result_selector);
  const [rule] = keep.keeps_records;
  const record = at(output, rule.output_selector);
  assert.deepEqual([record[rule.type_field], record[rule.id_field]], ['stance', `stance:file:${IDENTITY}`]);
  const refused = run(keep.invoke.argv.slice(1), { ...said, stance: 'agree', answered_by: 'ai' });
  assert.equal(refused.status, 1);
  assert.match(JSON.parse(refused.stdout.trim().split('\n').at(-1)).error, /answered_by/);
});
