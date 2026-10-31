import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findFilesInAnIndex } from '../read-data/find-files-in-an-index.mjs';

const script = new URL('../read-data/find-files-in-an-index.mjs', import.meta.url).pathname;

function indexWith(rows, fileName = 'assets.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-files-in-an-index-'));
  fs.writeFileSync(path.join(dir, fileName), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'content-types.json'), JSON.stringify({ stop_words: ['my', 'the'], type_keywords: { video: ['video', 'videos', 'clip'] } }));
  return dir;
}
const row = (name, content_type, text = null) => ({ path: `/x/${name}`, display_path: `lib/${name}`, name, root: 'drive-one', identity: 'ab', content_type, size: 5, tags: [], text });

test('a typed search never returns another type, and finds a clip by its spoken words', () => {
  const dir = indexWith([row('a1.mp4', 'video', 'soup ice cream is tasty'), row('soup.prproj', 'project'), row('a2.mp4', 'video', 'backhand')]);
  const out = findFilesInAnIndex({ index_dir: dir, query: 'soup video' });
  assert.deepEqual(out.hits.map((h) => h.display_path), ['lib/a1.mp4']);
  assert.equal(out.hits[0].identity, 'ab');
  assert.deepEqual(out.candidates_per_root, { 'drive-one': 2 });
});

test('a query of only type words returns no hits instead of unranked rows', () => {
  const dir = indexWith([row('a1.mp4', 'video')]);
  assert.deepEqual(findFilesInAnIndex({ index_dir: dir, query: 'video' }).hits, []);
});

test('the index file name and the field names are the request data', () => {
  const dir = indexWith([{ where: '/z/a.mp4', title: 'beach day', kind: 'video', drive: 'd1' }], 'rows.jsonl');
  const out = findFilesInAnIndex({ index_dir: dir, index_file: 'rows.jsonl', query: 'beach', type: 'video', fields: { path: 'where', display_path: 'where', name: 'title', type: 'kind', root: 'drive' } });
  assert.equal(out.hits[0].path, '/z/a.mp4');
  assert.equal(out.hits[0].root, 'd1');
});

test('picture-lane hits fuse with word hits, and a hit both lanes found ranks first', () => {
  const dir = indexWith([row('beach.mp4', 'video'), row('beach-sunset.mp4', 'video'), row('other.mp4', 'video')]);
  const lane = (names) => names.map((n, i) => ({ row: row(n, 'video'), score: 1 - i * 0.1 }));
  const out = findFilesInAnIndex({ index_dir: dir, query: 'beach', other_lanes: { picture: lane(['other.mp4', 'beach-sunset.mp4']) } });
  assert.equal(out.hits[0].found_by.length, 2);
  assert.ok(out.hits.some((h) => h.display_path === 'lib/other.mp4' && h.found_by.join() === 'picture'));
});

test('a missing index says where to look, and the command prints one JSON line', () => {
  assert.throws(() => findFilesInAnIndex({ index_dir: os.tmpdir() + '/no-such-index', query: 'x' }), /no index file/i);
  const dir = indexWith([row('a1.mp4', 'video', 'soup')]);
  const line = execFileSync('node', [script, JSON.stringify({ index_dir: dir, query: 'soup' })]).toString().trim();
  assert.equal(JSON.parse(line).hits.length, 1);
});

test('the row runs this command on the person\'s computer, reading only the folder the person granted', () => {
  const [tool] = JSON.parse(fs.readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map((record) => record.payload);
  assert.equal(tool.id, 'tool:find-files-in-an-index');
  assert.equal(tool.invoke.kind, 'computer');
  assert.deepEqual(tool.invoke.capabilities, ['read-a-folder']);
  assert.deepEqual(tool.placements, ['placement:your-computer']);
  assert.equal(tool.invoke.argv.at(-1), 'findFilesInAnIndex');
  assert.ok(tool.input_schema.required.includes('index_dir') && tool.input_schema.required.includes('query'));
});
