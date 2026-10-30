// tools/where-a-person-stands: a stand is the person's own, kept as one record per thing named by its identity, and read
// back with their words whole and every earlier stand from that record's versions; each row's sample runs as the tool
// container runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { artifactOf, stanceChoices, stanceRecord, stanceRecordId, standsFrom } from '../do-work/where-a-person-stands.mjs';

const folder = resolve(import.meta.dirname, '..');
const IDENTITY = `1f:${'a'.repeat(64)}`;
const OTHER = `1f:${'b'.repeat(64)}`;
const said = { artifact_ref: `file:${IDENTITY}`, answered_by: 'person' };

test('a stand names its thing by identity, with or without file:, and a name or a short identity is refused', () => {
  assert.equal(artifactOf(IDENTITY), IDENTITY);
  assert.equal(artifactOf(`file:${IDENTITY}`), IDENTITY);
  assert.equal(stanceRecordId(`file:${IDENTITY}`), stanceRecordId(IDENTITY));
  for (const named of ['/Content/probe/hello.txt', '1f:abc', `12:${'a'.repeat(64)}`, `1f:${'A'.repeat(64)}`, null]) {
    assert.throws(() => stanceRecord({ ...said, artifact_ref: named, stance: 'agree' }), /identity/, String(named));
  }
});

test('only the person\'s own stand is kept, with their words exactly, and partly is a stand of its own', () => {
  assert.throws(() => stanceRecord({ ...said, answered_by: 'ai', stance: 'agree' }), /answered_by/);
  assert.throws(() => stanceRecord({ ...said, stance: 'love' }), /agree, disagree, partly/);
  const why = '  Fine for now,  but the opening is slow. ';
  const kept = stanceRecord({ ...said, stance: 'partly', why, at: '2026-10-29T12:00:00Z' });
  assert.deepEqual(kept, { type: 'stance', id: `stance:${IDENTITY}`, artifact: IDENTITY, stance: 'partly',
    said: 'You partly agree with this.', why, by: 'person', at: '2026-10-29T12:00:00Z' });
  assert.deepEqual(stanceChoices().map(choice => choice.id), ['agree', 'disagree', 'partly']);
  const back = stanceRecord({ ...said, stance: null, why: 'ignored' });
  assert.deepEqual([back.stance, 'said' in back, 'why' in back], [null, false, false]);
});

test('the newest version is the stand, every older one is earlier, and silence or a stand taken back is no stand', () => {
  const versions = [
    stanceRecord({ ...said, stance: 'disagree', why: 'comes off as AI', at: '2026-10-29T13:44:00Z' }),
    { value: stanceRecord({ ...said, stance: 'agree', why: 'good', at: '2026-10-29T11:40:00Z' }) },
    { payload: stanceRecord({ ...said, artifact_ref: OTHER, stance: 'agree', at: '2026-10-29T10:00:00Z' }) },
    { type: 'message', artifact: IDENTITY, stance: 'agree', at: '2026-10-29T23:00:00Z' },
  ];
  const [one, other] = standsFrom(versions);
  assert.deepEqual([one.artifact, one.stance, one.why, one.at], [IDENTITY, 'disagree', 'comes off as AI', '2026-10-29T13:44:00Z']);
  assert.deepEqual(one.earlier.map(item => [item.stance, item.why]), [['agree', 'good']]);
  assert.equal(other.artifact, OTHER);
  assert.deepEqual(standsFrom(versions, OTHER).map(item => item.stance), ['agree']);
  const none = standsFrom(versions, `1f:${'c'.repeat(64)}`)[0];
  assert.deepEqual([none.stance, none.earlier], [null, []]);
  const takenBack = standsFrom([...versions, stanceRecord({ ...said, stance: null, at: '2026-10-30T09:00:00Z' })], IDENTITY)[0];
  assert.deepEqual([takenBack.stance, takenBack.earlier.length], [null, 2]);
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
  const ran = run(keep.invoke.argv.slice(1), { ...said, stance: 'agree', why: 'good', at: '2026-10-29T11:40:00Z' });
  const output = at(JSON.parse(ran.stdout.trim().split('\n').at(-1)), keep.result_selector);
  const [rule] = keep.keeps_records;
  const record = at(output, rule.output_selector);
  assert.deepEqual([record[rule.type_field], record[rule.id_field]], ['stance', `stance:${IDENTITY}`]);
  const refused = run(keep.invoke.argv.slice(1), { ...said, stance: 'agree', answered_by: 'ai' });
  assert.equal(refused.status, 1);
  assert.match(JSON.parse(refused.stdout.trim().split('\n').at(-1)).error, /answered_by/);
});
