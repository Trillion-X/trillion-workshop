// Runs the command for real against a stand-in for Ollama (test/fake_ollama.py) that answers from word rules and leaves one
// moment out of a multi-moment answer, and checks what the tool promises: moments cut by silence, buckets and relevance written
// back into each transcript, the vocabulary growing, a moment the model skipped asked about again alone, work not repeated,
// and the counts. Needs python3 only; the inputs are made here from synthetic words.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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

test('--limit without --dry-out is refused, saying why', () => {
  const out = tool('tag', '--transcripts', transcripts, '--limit', '2');
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /use it with --dry-out/);
});
