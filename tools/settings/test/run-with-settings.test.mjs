// tools/settings: reading a named row through the run's records door, on made-up rows in the stand-in door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { readSettingRecord, settingsFor, layOver, isSettingId } from '../read-data/settings.mjs';
import { runWithSettings } from '../do-work/run-with-settings.mjs';

const ID = 'record:setting:sample-tool~film~sample-film';
const ROW = { name: 'sample-tool for sample-film', tool: 'tool:sample', scope_kind: 'film', scope_id: 'sample-film', settings: '{"colours":{"ink":"#111111","paper":"#ffffff"},"fps":30}', from: 'made-up/sample.py@0000000', status: 'active' };
const RIGHTS = [{ kind: 'record:setting', prefix: 'record:setting:sample-tool~', operations: ['records:read'] }];
const ECHO = fileURLToPath(new URL('./echo_settings.py', import.meta.url));

async function withDoor(records, fn) {
  const fake = await startFakeDoor({ rights: RIGHTS, records });
  try { return await fn(openRecordsDoor({ descriptor: fake.descriptor })); } finally { await fake.close?.(); }
}
const collect = () => { const sink = { text: '' }; sink.out = new Writable({ write(chunk, _e, done) { sink.text += chunk; done(); } }); return sink; };

test('layOver merges plain objects key by key and replaces anything else whole; ids are told from paths', () => {
  assert.deepEqual(layOver({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { b: { c: 9 }, e: [7] }), { a: 1, b: { c: 9, d: 3 }, e: [7] });
  assert.equal(isSettingId(ID), true);
  assert.equal(isSettingId('/tmp/rows.json'), false);
});

test('readSettingRecord reads the row through the door, null when absent, and refuses another tool\'s row', async () => {
  await withDoor([{ id: ID, type: 'record:setting', value: ROW }], async door => {
    assert.deepEqual(await readSettingRecord(door, ID, { folder: 'sample-tool' }), { id: ID, type: 'record:setting', value: ROW });
    assert.equal(await readSettingRecord(door, 'record:setting:sample-tool~film~absent'), null);
    await assert.rejects(readSettingRecord(door, ID, { folder: 'another-tool' }), /belongs to tools\/sample-tool/);
  });
});

test('settingsFor lays the defaults, then the named row, then the input\'s own settings', async () => {
  await withDoor([{ id: ID, type: 'record:setting', value: ROW }], async door => {
    const defaults = { fps: 24, colours: { ink: '#000000', accent: '#ff0000' }, width: 1920 };
    const got = await settingsFor({ settings_record: ID, settings: { width: 1080 } }, { door, folder: 'sample-tool', defaults });
    assert.deepEqual(got.settings, { fps: 30, colours: { ink: '#111111', accent: '#ff0000', paper: '#ffffff' }, width: 1080 });
    assert.deepEqual(got.from, { id: ID, from: ROW.from });
    const handed = await settingsFor({ settings_record: { id: ID, type: 'record:setting', value: ROW } }, { folder: 'sample-tool', defaults });
    assert.equal(handed.settings.fps, 30);
    assert.deepEqual((await settingsFor({}, { defaults })).settings, defaults);
    await assert.rejects(settingsFor({ settings_record: 'record:setting:sample-tool~film~absent' }, { door, folder: 'sample-tool' }), /write the row first/);
    await assert.rejects(settingsFor({ settings_record: ID }, { folder: 'sample-tool' }), /no records door/);
    await assert.rejects(settingsFor({ settings: [1] }, {}), /JSON object/);
  });
});

test('run-with-settings hands a Python program the row it names, and request_settings lays it the same way', async () => {
  await withDoor([{ id: ID, type: 'record:setting', value: ROW }], async door => {
    const sink = collect();
    const code = await runWithSettings(['--folder', 'sample-tool', '--', 'python3', '-I', ECHO], { stdin: Readable.from([JSON.stringify({ settings_record: ID, settings: { width: 1080 }, words: 'hi' })]), door, out: sink.out });
    assert.equal(code, 0);
    const answer = JSON.parse(sink.text.trim().split('\n').at(-1));
    assert.deepEqual(answer.settings, { fps: 30, colours: { ink: '#111111', paper: '#ffffff', accent: '#ff0000' }, width: 1080, height: 1080 });
    assert.equal(answer.words, 'hi');
    assert.equal(answer.settings_from.id, ID);
    await assert.rejects(runWithSettings(['--folder', 'sample-tool', '--', 'python3', '-I', ECHO], { stdin: Readable.from([JSON.stringify({ settings_record: 'record:setting:sample-tool~film~absent' })]), door, out: collect().out }), /write the row first/);
  });
});

test('a request naming no row reaches the program unchanged, a bare id is refused there, and the command needs a program', async () => {
  const sink = collect();
  await runWithSettings(['--folder', 'sample-tool', '--', 'python3', '-I', ECHO], { stdin: Readable.from(['{"words":"plain"}']), out: sink.out });
  assert.equal(JSON.parse(sink.text.trim()).settings.fps, 24);
  const direct = spawnSync('python3', ['-I', ECHO], { input: JSON.stringify({ settings_record: ID }), encoding: 'utf8' });
  assert.match(direct.stdout + direct.stderr, /run-with-settings/);
  const command = fileURLToPath(new URL('../do-work/run-with-settings.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [command, '--folder', 'sample-tool'], { input: '{}', encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(JSON.parse(run.stdout.trim()).error, /usage/);
});
