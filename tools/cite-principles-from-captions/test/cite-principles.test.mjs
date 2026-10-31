// Runs the command for real on synthetic captions (five made-up videos from two made-up channels, made here) and checks what the
// tool promises: a corpus that says how each video did against its channel's usual, the passages worth reading, an exact-quote
// check that tells a wrong quote from a missing caption file, and a registry whose evidence is counted by independent channel.
// Needs python3 only.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  for (const file of ['test_captions.py', 'test_extraction.py']) {
    const out = run(join(folder, 'test', file));
    assert.equal(out.status, 0, out.stderr);
  }
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

test('corpus also reads word-timed transcripts from another site, with their info files kept elsewhere', () => {
  const both = join(work, 'corpus-both.jsonl');
  const out = tool('corpus', '--captions', join(work, 'captions'), '--transcripts', join(work, 'transcripts'), '--infos', join(work, 'infos'), '--out', both);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(lastLine(out.stdout).videos, 7);
  const videos = Object.fromEntries(lines(both).map(video => [video.id, video]));
  assert.deepEqual([videos.xvid1.platform, videos.xvid1.channel, videos.xvid1.words], ['twitter', 'Channel Gamma', 20]);
  assert.deepEqual(videos.xvid1.segs, [[0, 'I broke the habit by writing it down every night.'], [5, 'Then I told a friend who checked on me weekly.']]);
  assert.deepEqual(videos.xvid2.segs, [[0, 'Walk for ten minutes after you wake up and leave the phone'], [6, 'at home.']], 'words with no spacing entries are still joined by spaces');
  assert.equal(videos.vidA1.platform, null, 'an info file with no extractor and no page names no site');
});

test('corpus reads a harvester\'s caption lines as they are, and counts a video with no captions as without', () => {
  const file = join(work, 'captions-lines.jsonl');
  const entries = [
    { video_id: 'hv1', url: 'https://www.youtube.com/watch?v=hv1', seed: '@made-up', status: 'ready', language: 'en', format: 'json3',
      lines: [[0, 'Plant the seeds in rows.'], [3.5, ' '], [4.2, 'Water them at dusk.']],
      info: { id: 'hv1', title: 'Rows of seeds', channel: 'Channel Delta', duration: 30, view_count: 10, webpage_url: 'https://www.youtube.com/watch?v=hv1', description: 'A made-up garden.' } },
    { video_id: 'hv2', url: 'https://www.youtube.com/watch?v=hv2', seed: '@made-up', status: 'empty', lines: [], info: { id: 'hv2', channel: 'Channel Delta' } },
  ];
  writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  const out = join(work, 'corpus-lines.jsonl');
  const done = tool('corpus', '--caption-lines', file, '--out', out);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual([lastLine(done.stdout).videos, lastLine(done.stdout).without_captions], [1, 1]);
  const [video] = lines(out);
  assert.deepEqual([video.id, video.platform, video.channel, video.title, video.words, video.capfile], ['hv1', 'youtube', 'Channel Delta', 'Rows of seeds', 9, 'captions-lines.jsonl']);
  assert.deepEqual(video.segs, [[0, 'Plant the seeds in rows.'], [4.2, 'Water them at dusk.']], 'the lines are kept as said; a blank line is left out');
});

test('coverage counts videos, shorts and words per channel and the videos rows already cite', () => {
  const out = tool('coverage', '--corpus', corpus, '--rows', join(work, 'rows', 'a.jsonl'), '--out', join(work, 'coverage.json'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual({ ...lastLine(out.stdout), out: undefined }, { channels: 2, videos: 5, shorts: 1, words: 174, mined_videos: 4, rows: 4, out: undefined });
  const alpha = JSON.parse(readFileSync(join(work, 'coverage.json'), 'utf8')).channels.find(c => c.channel === 'Channel Alpha');
  assert.deepEqual([alpha.videos, alpha.shorts, alpha.mined_videos], [3, 1, 2]);
  const beta = JSON.parse(readFileSync(join(work, 'coverage.json'), 'utf8')).channels.find(c => c.channel === 'Channel Beta');
  assert.deepEqual([alpha.channel_url, beta.channel_url], ['https://example.com/@alpha', null], 'a channel\'s address is kept when its videos give one');
});

test('coverage separately counts completed videos with no rows and emits only cited source row files', () => {
  const video = lines(corpus)[0];
  const done = join(work, 'done-manifest.jsonl');
  writeFileSync(done, `${JSON.stringify({ video: video.id, failed_parts: 0 })}\n${JSON.stringify({ video: 'not-in-corpus', failed_parts: 0 })}\n`);
  const rejected = join(work, 'rejected-manifest.jsonl');
  writeFileSync(rejected, `${JSON.stringify({ video: video.id, why: 'not supported', row: { statement: 'Not admitted' } })}\n`);
  const outFile = join(work, 'coverage-manifest.json');
  const out = tool('coverage', '--corpus', corpus, '--rows', join(work, 'rows', 'a.jsonl'), done, rejected, '--done', done, '--out', outFile);
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(readFileSync(outFile));
  assert.equal(report.totals.completed_videos, 1);
  assert.equal(report.totals.rows, 4, 'completed and rejected ledger entries cannot inflate kept rows');
  assert.deepEqual(report.row_files, [{ path: 'rows/a.jsonl' }]);
});

test('extract asks the model about every part, keeps each quote as the caption words it came from, and a stop loses nothing', async () => {
  const both = join(work, 'corpus-both.jsonl');
  const server = spawn('python3', [join(folder, 'test', 'fake_chat.py')]);
  const port = await new Promise(resolve => server.stdout.once('data', data => resolve(String(data).trim())));
  try {
    const model = join(work, 'model.json');
    assert.equal(run(join(folder, 'test', 'write_json.py'), model, JSON.stringify({ url: `http://127.0.0.1:${port}/v1`, model: 'stand-in' })).status, 0);
    const out = join(work, 'extracted');
    const extract = (...more) => spawnAsync('python3', [script, 'extract', '--corpus', both, '--asks', join(work, 'asks.json'), '--model', model, '--out', out, '--retry-seconds', '0', ...more]);
    const progress = join(work, 'extract-progress.json');
    const first = await extract('--attempts', '1', '--concurrency', '2', '--coverage-out', progress, '--report-every', '1');
    assert.equal(first.status, 0, first.stderr);
    const done = () => lines(join(out, 'done.jsonl'));
    assert.equal(done().length, 7, 'every video has a line');
    assert.deepEqual(done().filter(d => d.failed_parts).map(d => [d.video, d.rows]), [['xvid1', 0]], 'a video with a part that failed keeps no rows');
    assert.equal(JSON.parse(readFileSync(progress)).totals.completed_videos, 6, 'failed video does not count complete');
    const second = await extract('--attempts', '1', '--coverage-out', progress);
    assert.equal(lastLine(second.stdout).videos, 1, 'the next run asks only for the video that failed');
    const manifest = JSON.parse(readFileSync(progress));
    assert.equal(manifest.totals.completed_videos, 7);
    assert.equal(manifest.row_files.length, 3, 'every channel file is available for downstream use, with no extraction ledger');
    const gamma = lines(join(out, 'Channel-Gamma.jsonl'));
    assert.equal(gamma.filter(r => r.sources[0].video === 'xvid1').length, 2, 'its rows are written once');
    const rows = ['Channel-Alpha', 'Channel-Beta', 'Channel-Gamma'].flatMap(name => lines(join(out, `${name}.jsonl`)));
    assert.ok(rows.every(r => r.extracted_by === 'stand-in' && r.asks === 'made-up asks' && !('quote' in r) && !('part' in r)));
    const exact = rows.find(r => r.id === 'xvid1@0#1');
    assert.deepEqual(exact.sources, [{ video: 'xvid1', platform: 'twitter', channel: 'Channel Gamma', guest: null, title: 'A broken habit', url: 'https://x.example/xvid1', t: 0, t_end: 5,
      quote: 'I broke the habit by writing it down', quote_match: 1 }]);
    const close = rows.find(r => r.statement === 'Idea two.' && r.sources[0].video === 'xvid1');
    assert.deepEqual([close.sources[0].quote, close.sources[0].quote_match], ['the habit by writing it down every night', 0.875], 'the caption\'s own words replace a quote with one word wrong');
    const verified = tool('verify', '--corpus', both, '--rows', join(out, 'Channel-*.jsonl'));
    assert.equal(verified.status, 0, verified.stdout);
    assert.equal(lastLine(verified.stdout).bad, 0);
    const dropped = lines(join(out, 'dropped.jsonl'));
    assert.ok(dropped.length >= 7 && dropped.every(d => d.why === 'quote not said in the part'));
    const packed = rows.filter(r => ['vidA2', 'vidA3'].includes(r.sources[0].video));
    assert.deepEqual(new Set(packed.map(r => r.sources[0].video)), new Set(['vidA2', 'vidA3']), 'short videos read together keep their own rows');
  } finally {
    server.kill();
  }
});

function spawnAsync(command, argv) {
  return new Promise(resolve => {
    const child = spawn(command, argv);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function round2(x) { return Math.round(x * 100) / 100; }
