import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findFilesInAnIndex, findFilesInAnIndexForARun } from '../read-data/find-files-in-an-index.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';

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
  assert.equal(tool.invoke.argv.at(-1), 'findFilesInAnIndexForARun');
  assert.deepEqual(tool.invoke.records.rights, [{ kind: 'record:setting', prefix: 'record:setting:find-files-in-an-index~', operations: ['records:read'] }]);
  assert.deepEqual(tool.input_schema.required, []);
  assert.deepEqual(tool.input_schema.anyOf, [{ required: ['query'] }, { required: ['names'] }]);
});

const named = (name, root = 'drive-one', content_type = 'video') => ({ path: `/x/${name}`, display_path: `lib/${root}/${name}`, name, root, identity: 'ab', content_type, size: 5, tags: [], text: null });

test('names look up where files are kept: exact stem, prefix with *, one answer per name, absences listed', () => {
  const dir = indexWith([named('C001.MP4'), named('C002.MP4'), named('C0010.MP4'), named('clip.take.2.mov'), named('C001.MP4', 'drive-two'), named('notes', 'drive-one', 'doc')]);
  const out = findFilesInAnIndex({ index_dir: dir, names: ['C001', 'c00*', 'clip.take.2', 'C002.MP4', 'absent'] });
  assert.deepEqual(out.by_name['C001'], ['lib/drive-one/C001.MP4', 'lib/drive-two/C001.MP4']);
  assert.deepEqual(out.by_name['c00*'], ['lib/drive-one/C001.MP4', 'lib/drive-one/C0010.MP4', 'lib/drive-one/C002.MP4', 'lib/drive-two/C001.MP4']);
  assert.deepEqual(out.by_name['clip.take.2'], ['lib/drive-one/clip.take.2.mov']);
  assert.deepEqual(out.by_name['C002.MP4'], []);
  assert.deepEqual(out.not_in_index, ['C002.MP4', 'absent']);
  assert.equal(out.matched, 0);
});

test('an exact name is case sensitive and a * name is not, as the lookup this was moved from was', () => {
  const dir = indexWith([named('Take7.MP4')]);
  const out = findFilesInAnIndex({ index_dir: dir, names: ['take7', 'TAKE*'] });
  assert.deepEqual(out.by_name, { take7: [], 'TAKE*': ['lib/drive-one/Take7.MP4'] });
});

test('names honour type and root, list a path once, and fall back to path when there is no display path', () => {
  const dir = indexWith([named('A1.mp4'), named('A1.mp4'), named('A1.wav', 'drive-one', 'audio'), named('A1.mp4', 'drive-two'), { path: '/only/path/A1.mp4', name: 'A1.mp4', root: 'drive-one', content_type: 'video' }]);
  const out = findFilesInAnIndex({ index_dir: dir, names: ['A1'], type: 'video', root: 'drive-one' });
  assert.deepEqual(out.by_name.A1, ['/only/path/A1.mp4', 'lib/drive-one/A1.mp4']);
});

test('names and a query together answer both, and a bad names list is refused with what to give', () => {
  const dir = indexWith([named('beach.mp4')]);
  const both = findFilesInAnIndex({ index_dir: dir, query: 'beach', names: ['beach'] });
  assert.equal(both.hits.length, 1);
  assert.deepEqual(both.by_name.beach, ['lib/drive-one/beach.mp4']);
  assert.throws(() => findFilesInAnIndex({ index_dir: dir, names: [] }), /names must be a list/);
  assert.throws(() => findFilesInAnIndex({ index_dir: dir, names: [''] }), /names must be a list/);
});

test('the command takes names on the command line and prints one JSON line', () => {
  const dir = indexWith([named('Z9.MP4')]);
  const line = execFileSync('node', [script, JSON.stringify({ index_dir: dir, names: ['Z9'] })]).toString().trim();
  assert.deepEqual(JSON.parse(line).by_name, { Z9: ['lib/drive-one/Z9.MP4'] });
});

const SETTING = 'record:setting:find-files-in-an-index~person~all';
const settingRow = settings => ({ name: 'Where my clips are indexed', tool: 'tool:find-files-in-an-index', scope_kind: 'person', scope_id: 'all', settings, from: 'made up', status: 'active' });

test('a run\'s settings fill the keys the request leaves out, and the request\'s own keys win', async () => {
  const dir = indexWith([named('K1.MP4'), named('K1.MP4', 'drive-two'), named('K1.wav', 'drive-one', 'audio')]);
  const out = await findFilesInAnIndexForARun({ names: ['K1'], settings: { index_dir: dir, type: 'video', root: 'drive-one' } });
  assert.deepEqual(out.by_name.K1, ['lib/drive-one/K1.MP4']);
  const wider = await findFilesInAnIndexForARun({ names: ['K1'], root: 'drive-two', settings: { index_dir: dir, type: 'video', root: 'drive-one' } });
  assert.deepEqual(wider.by_name.K1, ['lib/drive-two/K1.MP4']);
  const plain = await findFilesInAnIndexForARun({ index_dir: dir, names: ['K1'] });
  assert.equal(plain.by_name.K1.length, 3);
  await assert.rejects(findFilesInAnIndexForARun({ names: ['K1'], settings: { index_dir: dir, colour: 'red' } }), /not this tool's: colour/);
});

test('settings_record is read through the run\'s records door, and a row the person does not keep is refused', async () => {
  const dir = indexWith([named('K2.MP4'), named('K2.MP4', 'drive-two')]);
  const fake = await startFakeDoor({ rights: [{ kind: 'record:setting', prefix: 'record:setting:find-files-in-an-index~', operations: ['records:read'] }],
    records: [{ id: SETTING, type: 'record:setting', value: settingRow({ index_dir: dir, root: 'drive-two', type: 'video' }) }] });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    const out = await findFilesInAnIndexForARun({ names: ['K2'], settings_record: SETTING }, { door });
    assert.deepEqual(out.by_name.K2, ['lib/drive-two/K2.MP4']);
    assert.deepEqual(out.settings_from, { id: SETTING, from: 'made up' });
    await assert.rejects(findFilesInAnIndexForARun({ names: ['K2'], settings_record: 'record:setting:find-files-in-an-index~film~absent' }, { door }), /No record:setting:find-files-in-an-index~film~absent/);
    await assert.rejects(findFilesInAnIndexForARun({ names: ['K2'], settings_record: 'record:setting:another-tool~person~all' }, { door }), /belongs to tools\/another-tool/);
  } finally { await fake.close?.(); }
});

test('a settings record handed in itself is read, its settings as JSON text, and a retired row is refused', async () => {
  const dir = indexWith([named('K3.MP4'), named('K3.MP4', 'drive-two')]);
  const record = status => ({ id: SETTING, type: 'record:setting', value: { ...settingRow({}), settings: JSON.stringify({ index_dir: dir, root: 'drive-two' }), status } });
  const out = await findFilesInAnIndexForARun({ names: ['K3'], settings_record: record('active') });
  assert.deepEqual(out.by_name.K3, ['lib/drive-two/K3.MP4']);
  await assert.rejects(findFilesInAnIndexForARun({ names: ['K3'], settings_record: record('retired') }), /retired/);
});
