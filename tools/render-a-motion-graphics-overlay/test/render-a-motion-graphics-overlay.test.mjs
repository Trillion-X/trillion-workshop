// tools/render-a-motion-graphics-overlay: the row's command reads the look and the spec from made-up rows of
// list:settings (the look row as main's makeRecord writes it, settings as JSON text) in a stand-in records door and renders; the Python tests run beside it. Needs python3 with Pillow,
// numpy and OpenCV, and ffmpeg; without them the render tests are skipped with the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { renderOverlay, withSpec, FOLDER } from '../do-work/render-overlay.mjs';
import { makeRecord } from '../../settings/read-data/settings.mjs';

const tool = fileURLToPath(new URL('..', import.meta.url));
const example = join(tool, 'read-data', 'example-look');
const look = JSON.parse(readFileSync(join(example, 'look.json'), 'utf8'));
const probe = spawnSync('python3', ['-c', 'import PIL, numpy, cv2'], { encoding: 'utf8' });
const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const missing = probe.status !== 0 ? `needs python3 with Pillow, numpy and OpenCV (${(probe.stderr || '').trim().split('\n').at(-1)})`
  : ffmpeg.status !== 0 || !/prores_ks/.test(ffmpeg.stdout) ? 'needs ffmpeg with prores_ks' : false;

const LOOK_ID = `record:setting:${FOLDER}~film~sample-film`;
const PIECE_ID = `record:setting:${FOLDER}~piece~sample-01`;
const SPEC = { id: 'sample-01', duration_s: 2.0, canvas: [640, 360], events: [
  { type: 'strip', id: 'line', text: 'made-up words', font: 'typewriter', size: 34, paper: 'white', pos: [160, 150], at: 0.2 },
  { type: 'exit', at: 1.2 }] };
const row = (id, scope_kind, scope_id, settings, status = 'active') => ({ id, type: 'record:setting', value: {
  name: `${FOLDER} ${scope_id}`, tool: `tool:${FOLDER}`, scope_kind, scope_id, settings, from: 'made-up@0000000', status } });
const RIGHTS = [{ kind: 'record:setting', prefix: `record:setting:${FOLDER}~`, operations: ['records:read'] }];

async function withDoor(records, fn) {
  const fake = await startFakeDoor({ rights: RIGHTS, records });
  try { return await fn(openRecordsDoor({ descriptor: fake.descriptor })); } finally { await fake.close?.(); }
}

test('withSpec reads a piece\'s spec from its row and refuses what it cannot use', async () => {
  await withDoor([row(PIECE_ID, 'piece', 'sample-01', { spec: SPEC }), row(`record:setting:${FOLDER}~piece~old`, 'piece', 'old', { spec: SPEC }, 'retired'),
    row(`record:setting:${FOLDER}~piece~empty`, 'piece', 'empty', {})], async door => {
    const got = await withSpec({ spec_record: PIECE_ID, out: 'x' }, door);
    assert.deepEqual(got.spec, SPEC);
    assert.equal(got.spec_record, undefined);
    assert.deepEqual(got.spec_from, { id: PIECE_ID, from: 'made-up@0000000' });
    await assert.rejects(withSpec({ spec_record: `record:setting:${FOLDER}~piece~absent` }, door), /Write the piece's row first/);
    await assert.rejects(withSpec({ spec_record: `record:setting:${FOLDER}~piece~old` }, door), /retired/);
    await assert.rejects(withSpec({ spec_record: `record:setting:${FOLDER}~piece~empty` }, door), /holds no settings.spec/);
    await assert.rejects(withSpec({ spec_record: 'record:setting:another-tool~piece~x' }, door), /belongs to tools\/another-tool/);
    await assert.rejects(withSpec({ spec_record: PIECE_ID, spec: SPEC }, door), /not both/);
    await assert.rejects(withSpec({ out: 'x' }, door), /Give the spec/);
  });
});

test('the command renders a piece from the film\'s look row and the piece\'s row', { skip: missing, timeout: 300_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'overlay-'));
  try {
    await withDoor([makeRecord(FOLDER, 'film', 'sample-film', look, { name: 'made-up look', tool: `tool:${FOLDER}`, source: 'made-up@0000000' }), row(PIECE_ID, 'piece', 'sample-01', { spec: SPEC })], async door => {
      let printed = '';
      const sink = new Writable({ write(chunk, _e, done) { printed += chunk; done(); } });
      const request = { settings_record: LOOK_ID, spec_record: PIECE_ID, assets: example, out };
      const code = await renderOverlay({ stdin: Readable.from([JSON.stringify(request)]), door, out: sink });
      assert.equal(code, 0, printed);
      const { result } = JSON.parse(printed.trim().split('\n').at(-1));
      assert.equal(result.id, 'sample-01');
      assert.equal(result.frames, 48);
      assert.equal(JSON.parse(readFileSync(result.timeline, 'utf8')).elements[0].id, 'line');
    });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the Python tests pass (render, refusals, event binding, lock, still slides)', { skip: missing, timeout: 900_000 }, () => {
  const run = spawnSync('python3', [join(tool, 'test', 'test_render_a_motion_graphics_overlay.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(-3000));
});
