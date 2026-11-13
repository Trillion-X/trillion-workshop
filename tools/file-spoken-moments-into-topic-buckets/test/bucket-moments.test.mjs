// Runs the command for real against a stand-in for Ollama (test/fake_ollama.py) that answers from word rules and leaves one
// moment out of a multi-moment answer, and checks what the tool promises: moments cut by silence, buckets and relevance written
// back into each transcript, the vocabulary growing, a moment the model skipped asked about again alone, work not repeated,
// and the counts. Needs python3 only; the inputs are made here from synthetic words.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const script = join(folder, 'do-work', 'bucket_moments.py');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const run = (...argv) => spawnSync('python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lastLine = out => JSON.parse(out.trim().split('\n').pop()).result;
const lines = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));

let work, server, url, requestLog, transcripts;
const tool = (...argv) => run(script, ...argv, '--ollama-url', url);
const asked = () => (existsSync(requestLog) ? lines(requestLog) : []);

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'bucket-moments-'));
  requestLog = join(work, 'requests.jsonl');
  transcripts = join(work, 'transcripts');
  assert.equal(run(join(folder, 'test', 'write_fixtures.py'), work).status, 0, 'the synthetic inputs are written');
  server = spawn('python3', [join(folder, 'test', 'fake_ollama.py'), requestLog]);
  const port = await new Promise(resolve => server.stdout.once('data', chunk => resolve(String(chunk).trim())));
  url = `http://127.0.0.1:${port}`;
});
after(() => server?.kill());

test('the row runs on the person\'s computer and names the script that exists', () => {
  assert.equal(row.id, 'tool:file-spoken-moments-into-topic-buckets');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.ok(existsSync(script));
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.licence_class, 'licence:maker-own');
});

test('the pure parts keep their promises', () => {
  const out = run(join(folder, 'test', 'test_moments.py'));
  assert.equal(out.status, 0, out.stderr);
});

test('--dry-out writes the moments to a file, leaves the transcripts alone, and asks again alone for the moment the model left out', () => {
  const dry = join(work, 'dry.jsonl');
  const out = tool('tag', '--transcripts', transcripts, '--dry-out', dry, '--clips', 'take');
  assert.equal(out.status, 0, out.stderr);
  const moments = lines(dry);
  assert.deepEqual(moments.map(x => [x.id, x.segments]), [['take#0', [0, 1]], ['take#1', [2]], ['take#2', [3]], ['take#3', [4]]]);
  assert.deepEqual(moments.map(x => x.buckets), [['money_talk'], ['gardening_tips', 'plants', 'soil'], ['gardening_tips', 'plants', 'soil'], []]);
  assert.deepEqual(moments.map(x => x.relevance), [0.8, 0.7, 0.7, 0.05]);
  assert.equal(JSON.parse(readFileSync(join(transcripts, 'take.words.json'), 'utf8')).moments, undefined);
  assert.deepEqual(asked().map(r => r.asked), [[0, 1, 2, 3], [1]]);
  assert.equal(asked()[0].model, 'qwen2.5:14b-instruct');
});

test('tag writes each moment into its transcript, grows the vocabulary and does not ask again next time', () => {
  const before = asked().length;
  const out = tool('tag', '--transcripts', transcripts);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /take 4 moments/);
  assert.match(out.stdout, /words-only has no segments, left alone/);
  const doc = JSON.parse(readFileSync(join(transcripts, 'take.words.json'), 'utf8'));
  assert.equal(doc.moments.length, 4);
  assert.deepEqual([doc.segments[0].moment, doc.segments[0].buckets, doc.segments[0].relevance], ['take#0', ['money_talk'], 0.8]);
  const vocabulary = JSON.parse(readFileSync(join(transcripts, 'buckets.json'), 'utf8')).buckets;
  assert.deepEqual([vocabulary.money_talk, vocabulary.gardening_tips.origin, Object.keys(vocabulary)], [{ description: 'talk about money', origin: 'model' }, 'model', ['money_talk', 'gardening_tips', 'plants', 'soil']]);
  assert.equal(asked().slice(before).length, 2);
  assert.equal(asked().at(-1).vocabulary, true, 'the second request shows the model the vocabulary grown so far');
  tool('tag', '--transcripts', transcripts);
  assert.equal(asked().length, before + 2, 'a tagged transcript is not asked about again');
});

test('report counts moments per bucket and per relevance band', () => {
  const result = lastLine(run(script, 'report', '--transcripts', transcripts).stdout);
  assert.equal(result.moments, 4);
  assert.equal(result.untagged, 0);
  assert.deepEqual(result.bands, { 'usable >=0.5': 3, 'irrelevant <0.15': 1 });
  assert.deepEqual(result.per_bucket.map(b => [b.bucket, b.moments]), [['gardening_tips', 2], ['plants', 2], ['soil', 2], ['money_talk', 1]]);
});

test('tag-moments tags a file of moments, keeps their other fields, and a rerun adds nothing', () => {
  const tagged = join(work, 'tagged.jsonl');
  const first = tool('tag-moments', '--moments', join(work, 'moments.jsonl'), '--tagged', tagged, '--batch', '2');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(lines(tagged).map(x => [x.id, x.where, x.buckets]), [['m0', 'file-0', ['money_talk']], ['m1', 'file-1', ['gardening_tips', 'plants', 'soil']], ['m2', 'file-2', []]]);
  assert.equal(asked().at(-1).model, 'gemma3:4b');
  const before = asked().length;
  assert.equal(lastLine(tool('tag-moments', '--moments', join(work, 'moments.jsonl'), '--tagged', tagged).stdout).already_tagged, 3);
  assert.equal(asked().length, before);
  assert.equal(lines(tagged).length, 3);
});

test('--vocabulary-rows files moments under the person\'s own rows only, and the model cannot add a bucket', () => {
  const rows = join(work, 'themes.json');
  writeFileSync(rows, JSON.stringify({ records: [{ id: 'record:themes:money-talk', value: { theme: 'Money talk', about: 'what a person does with money' } },
    { id: 'record:themes:gardening-tips', value: { theme: 'Gardening', about: 'looking after a garden' } }] }));
  const tagged = join(work, 'tagged-rows.jsonl');
  const out = tool('tag-moments', '--moments', join(work, 'moments.jsonl'), '--tagged', tagged, '--vocabulary-rows', rows, '--describe', 'about', '--label', 'theme');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lines(tagged).map(x => [x.id, x.buckets]), [['m0', ['money-talk']], ['m1', ['gardening-tips']], ['m2', []]]);
  const kept = JSON.parse(readFileSync(`${tagged}.buckets.json`, 'utf8'));
  assert.deepEqual(Object.keys(kept.buckets), ['money-talk', 'gardening-tips']);
  assert.equal(kept.closed, true);
});

test('a moment the model cannot answer (a 500) is asked alone, left untagged with no buckets, and the others are still tagged', () => {
  const moments = join(work, 'loop.jsonl'), tagged = join(work, 'loop-tagged.jsonl');
  writeFileSync(moments, ['Money is a tool.', 'loopforever loopforever', 'Gardens need patience.'].map((text, i) => JSON.stringify({ id: `l${i}`, text })).join('\n') + '\n');
  const out = tool('tag-moments', '--moments', moments, '--tagged', tagged, '--batch', '3');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lines(tagged).map(x => [x.id, x.buckets, x.relevance]), [['l0', ['money_talk'], 0.8], ['l1', [], null], ['l2', ['gardening_tips', 'plants', 'soil'], 0.7]]);
});

test('cut-ideas writes one moment per idea the model marks, each with its start and end seconds, and a rerun adds nothing', () => {
  const out = join(work, 'ideas.jsonl');
  const first = tool('cut-ideas', '--transcripts', join(work, 'ideas'), '--out', out, '--window', '4');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(lines(out).map(x => [x.id, x.start, x.end, x.segments]), [['talk#0', 0, 6, [0, 1]], ['talk#1', 8, 14, [2, 3]], ['talk#2', 40, 45, [4, 5]]]);
  assert.equal(lines(out)[1].text, 'New idea: gardens. They need patience.');
  assert.equal(lines(out)[0].cut, 'model');
  const before = asked().length;
  assert.equal(lastLine(tool('cut-ideas', '--transcripts', join(work, 'ideas'), '--out', out).stdout).already_cut, 1);
  assert.equal(asked().length, before);
  assert.equal(lines(out).length, 3);
});

test('cut-ideas never splits an idea at a window edge: the window carries on from the idea that touched it', () => {
  const out = join(work, 'ideas-edge.jsonl');
  assert.equal(tool('cut-ideas', '--transcripts', join(work, 'ideas'), '--out', out, '--window', '3').status, 0);
  assert.deepEqual(lines(out).map(x => [x.start, x.end, x.segments]), [[0, 6, [0, 1]], [8, 14, [2, 3]], [40, 45, [4, 5]]]);
});

test('cut-ideas --min-words joins an idea shorter than that to its neighbour', () => {
  const out = join(work, 'ideas-min.jsonl');
  assert.equal(tool('cut-ideas', '--transcripts', join(work, 'ideas'), '--out', out, '--min-words', '6').status, 0);
  assert.deepEqual(lines(out).map(x => [x.start, x.end, x.segments]), [[0, 45, [0, 1, 2, 3, 4, 5]]]);
});

test('cut-ideas falls back to the silence cut for a window the model refuses, and says so on the moments', () => {
  const folder = join(work, 'ideas-bad'), out = join(work, 'ideas-bad.jsonl');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'bad.words.json'), JSON.stringify({ timing: 'word', segments: [{ text: 'loopforever', start: 0, end: 2 }, { text: 'more', start: 2, end: 3 }, { text: 'later', start: 20, end: 22 }] }));
  const run1 = tool('cut-ideas', '--transcripts', folder, '--out', out);
  assert.equal(run1.status, 0, run1.stderr);
  assert.deepEqual(lines(out).map(x => [x.start, x.end, x.cut]), [[0, 3, 'silence'], [20, 22, 'silence']]);
});

test('--limit without --dry-out is refused, saying why', () => {
  const out = tool('tag', '--transcripts', transcripts, '--limit', '2');
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /use it with --dry-out/);
});
