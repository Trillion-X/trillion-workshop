// Runs the command for real on synthetic captions (five made-up videos from two made-up channels, made here) and checks what the
// tool promises: a corpus that says how each video did against its channel's usual, the passages worth reading, an exact-quote
// check that tells a wrong quote from a missing caption file, and a registry whose evidence is counted by independent channel.
// Needs python3 only.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const script = join(folder, 'do-work', 'cite_principles.py');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const run = (...argv) => spawnSync('python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tool = (...argv) => run(script, ...argv);
const lastLine = out => JSON.parse(out.trim().split('\n').pop()).result;
const lines = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));

let work, corpus;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'cite-principles-'));
  corpus = join(work, 'corpus.jsonl');
  assert.equal(run(join(folder, 'test', 'make_fixture.py'), work).status, 0, 'the synthetic inputs are written');
});

test('the row runs on the person\'s computer and names the script that exists', () => {
  assert.equal(row.id, 'tool:cite-principles-from-captions');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.ok(existsSync(script));
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.licence_class, 'licence:maker-own');
});

test('the pure readers keep their promises', () => {
  const out = run(join(folder, 'test', 'test_captions.py'));
  assert.equal(out.status, 0, out.stderr);
});

test('corpus keeps each captioned video with how it did against its channel\'s usual and skips one with no captions', () => {
  const out = tool('corpus', '--captions', join(work, 'captions'), '--views-table', join(work, 'views.tsv'), '--out', corpus);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lastLine(out.stdout), { videos: 5, without_captions: 1, corpus });
  const videos = Object.fromEntries(lines(corpus).map(video => [video.id, video]));
  assert.deepEqual([videos.vidA1.median, videos.vidA1.xmed, videos.vidA1.kind], [550, 1.82, 'video']);
  assert.deepEqual([videos.vidA3.kind, videos.vidA3.median, videos.vidA3.xmed], ['short', 50, 1]);
  assert.equal(videos.vidB1.xmed, 1.98);
  assert.equal(videos.vidA1.segs.length, 8);
  assert.equal(videos.vidA1.capfile, 'vidA1.en.json3');
});

test('candidates keeps the best windows per channel and each channel\'s openings, best video first', () => {
  const out = tool('candidates', '--corpus', corpus, '--terms', join(work, 'terms.json'), '--out', join(work, 'cands'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lastLine(out.stdout).channels, [{ channel: 'Channel Alpha', videos: 3, passages: 1 }, { channel: 'Channel Beta', videos: 2, passages: 1 }]);
  const alpha = lines(join(work, 'cands', 'Channel-Alpha.jsonl'));
  assert.deepEqual([alpha[0].id, alpha[0].t], ['vidA1', 0]);
  assert.match(alpha[0].text, /water the soil/);
  assert.ok(alpha[0].score > lines(join(work, 'cands', 'Channel-Beta.jsonl'))[0].score);
  const openings = lines(join(work, 'cands', 'openings.jsonl'));
  assert.deepEqual(openings.filter(o => o.channel === 'Channel Alpha').map(o => o.id), ['vidA1', 'vidA3', 'vidA2']);
  assert.ok(openings[0].text.startsWith('welcome to the garden channel'));
  assert.ok(!openings[0].text.includes('that is the whole idea'), 'only the first 45 seconds');
});

test('a cap file limits how many passages a channel keeps', () => {
  const caps = join(work, 'caps.json');
  assert.equal(run(join(folder, 'test', 'write_json.py'), caps, '{"Channel Beta": 0}').status, 0);
  const out = tool('candidates', '--corpus', corpus, '--terms', join(work, 'terms.json'), '--caps', caps, '--out', join(work, 'capped'));
  assert.deepEqual(lastLine(out.stdout).channels.map(c => c.passages), [1, 0]);
});

test('find says the second a quote is said at, and tells a missing quote from a missing video', () => {
  const found = tool('find', '--corpus', corpus, '--video', 'vidA1', '--quote', 'The SECRET is patience');
  assert.equal(found.stdout.split('\n')[0], '10');
  assert.equal(found.status, 0);
  const notFound = tool('find', '--corpus', corpus, '--video', 'vidA1', '--quote', 'never said');
  assert.deepEqual([notFound.status, notFound.stdout.split('\n')[0]], [1, 'NOTFOUND']);
  const noVideo = tool('find', '--corpus', corpus, '--video', 'vidNope', '--quote', 'x');
  assert.deepEqual([noVideo.status, noVideo.stdout.split('\n')[0]], [2, 'NOVIDEO']);
});

test('verify passes real quotes and names a wrong quote, a quote at the wrong second, a missing caption file and a bad line', () => {
  const good = tool('verify', '--corpus', corpus, '--rows', join(work, 'rows', 'a.jsonl'));
  assert.equal(good.status, 0, good.stdout);
  assert.deepEqual(lastLine(good.stdout), { rows: 4, quotes: 5, bad: 0, missing: 0 });
  const bad = tool('verify', '--corpus', corpus, '--rows', join(work, 'rows', 'bad.jsonl'), '--caption-files', join(work, 'more', '{video}', '{video}.*json3'));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^BAD X-1 vidA1 nobody ever said this$/m);
  assert.match(bad.stdout, /^TOFF X-1 vidA1 99 10$/m);
  assert.match(bad.stdout, /^MISSING X-2 vidNope \(no caption file\)$/m);
  assert.match(bad.stdout, /^JSONERR .*bad\.jsonl 2 /m);
  assert.doesNotMatch(bad.stdout, /vidX/, 'a caption file outside the corpus is found by its glob and its quote matches');
  assert.deepEqual(lastLine(bad.stdout), { rows: 2, quotes: 5, bad: 1, missing: 1 });
});

test('registry merges rows by the person\'s groups, counts evidence by independent channel and links contradictions both ways', () => {
  const out = tool('registry', '--corpus', corpus, '--rows', join(work, 'rows', 'a.jsonl'), '--lanes', join(work, 'lanes.json'), '--merge', join(work, 'merge.json'),
    '--out', join(work, 'principles.jsonl'), '--id-map', join(work, 'map.json'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual({ ...lastLine(out.stdout), registry: undefined }, { principles: 3, quotes: 4, demonstrations: 1, registry: undefined });
  const [merged, weeds, daily] = lines(join(work, 'principles.jsonl'));
  assert.deepEqual([merged.id, merged.principle, merged.kind, merged.staging_ids], ['P-001', 'Look after the soil first.', 'stated', ['R-1', 'R-2']]);
  assert.deepEqual(merged.lanes, ['soil', 'feeding'], 'a lane renamed to one already there is kept once');
  assert.deepEqual(merged.stages, ['stage one', 'stage two']);
  assert.deepEqual(merged.channels, ['Channel Alpha', 'Channel Beta']);
  assert.deepEqual(merged.evidence, { independent_channels: 2, videos: 2, quotes: 2, demonstrations: 0, strength: round2(Math.log2(1 + 1.82) + Math.log2(1 + 1.98)) });
  assert.equal(merged.paraphrase, 'PARAPHRASE: Water first.');
  assert.deepEqual(merged.merged_from.map(m => m.staging_id), ['R-1', 'R-2']);
  assert.equal(merged.sources[0].url, 'https://youtu.be/vidA1?t=5');
  assert.equal(merged.sources[0].title, 'How to plan a garden');
  assert.deepEqual([weeds.id, weeds.kind, weeds.evidence.demonstrations, weeds.evidence.strength], ['P-002', 'demonstrated', 1, round2(0.5 * Math.log2(1 + 0.18))]);
  assert.deepEqual(weeds.contradicts, [
    { with_ids: ['P-001'], how: 'leave or pull', recorded_by: 'batch R' },
    { with_ids: [], with_text: 'someone online says weeds are fine', how: 'opinion', recorded_by: 'batch R' },
    { with_ids: ['P-003'], how: 'weeds or habit', recorded_by: 'the test file' }]);
  assert.deepEqual(daily.contradicts, [{ with_ids: ['P-002'], how: 'weeds or habit', recorded_by: 'the test file' }]);
  assert.deepEqual(JSON.parse(readFileSync(join(work, 'map.json'), 'utf8')), { 'R-1': 'P-001', 'R-2': 'P-001', 'R-3': 'P-002', 'R-4': 'P-003' });
});

test('registry without a lanes or merge file keeps each row on its own with no stages', () => {
  const out = tool('registry', '--corpus', corpus, '--rows', join(work, 'rows', 'a.jsonl'), '--out', join(work, 'plain.jsonl'));
  assert.equal(lastLine(out.stdout).principles, 4);
  assert.ok(lines(join(work, 'plain.jsonl')).every(p => p.stages.length === 0 && !p.merged_from));
});

function round2(x) { return Math.round(x * 100) / 100; }
