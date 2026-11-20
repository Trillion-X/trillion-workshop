// tools/render-a-motion-graphics-overlay: the row's command takes the look row (as main's makeRecord writes it, settings as
// JSON text) and the piece's spec in the request, with no records door, and renders; the Python tests run beside it. Needs python3 with Pillow,
// numpy and OpenCV, and ffmpeg; without them the render tests are skipped with the reason.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import rows from '../tool-rows.json' with { type: 'json' };
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { renderOverlay, withSpec, refuseRowIds, FOLDER } from '../do-work/render-overlay.mjs';
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
const lookRecord = makeRecord(FOLDER, 'film', 'sample-film', look, { name: 'made-up look', tool: `tool:${FOLDER}`, source: 'made-up@0000000' });

test('withSpec takes the spec in the request and refuses what it cannot use', () => {
  assert.deepEqual(withSpec({ spec: SPEC, out: 'x' }).spec, SPEC);
  assert.throws(() => withSpec({ spec_record: PIECE_ID }), /spec_record is not read here: give the piece row's settings.spec as spec/);
  assert.throws(() => withSpec({ out: 'x' }), /Give the spec/);
  assert.throws(() => withSpec([]), /one JSON object/);
});

test('a row named by its id is refused: the row itself is what the request carries', () => {
  assert.throws(() => refuseRowIds({ settings_record: LOOK_ID }, ['settings_record']), /settings_record is a row's id: give the row itself/);
  refuseRowIds({ settings_record: lookRecord }, ['settings_record']);
});

test('the row holds no records door and does not accept a row id', () => {
  const row = rowOf(rows, 'tool:render-a-motion-graphics-overlay');
  assert.equal(row.invoke.records, undefined);
  assert.doesNotMatch(JSON.stringify(row.invoke.files), /records-door|run-with-settings/, 'nothing reads the setting for the tool: no records door and no settings wrapper are packed');
  assert.equal(row.input_schema.properties.spec_record, undefined);
  assert.deepEqual(row.input_schema.properties.settings_record.type, 'object');
});

test('the command renders a piece from the film\'s look row and the piece\'s spec', { skip: missing, timeout: 300_000 }, async () => {
  const out = tempFolder(join(tmpdir(), 'overlay-'));
  try {
    let printed = '';
    const sink = new Writable({ write(chunk, _e, done) { printed += chunk; done(); } });
    const request = { settings_record: lookRecord, spec: SPEC, assets: example, out };
    const code = await renderOverlay({ stdin: Readable.from([JSON.stringify(request)]), out: sink });
    assert.equal(code, 0, printed);
    const { result } = JSON.parse(printed.trim().split('\n').at(-1));
    assert.equal(result.id, 'sample-01');
    assert.equal(result.frames, 48);
    assert.equal(JSON.parse(readFileSync(result.timeline, 'utf8')).elements[0].id, 'line');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the Python tests pass (render, refusals, event binding, lock, still slides)', { skip: missing, timeout: 900_000 }, () => {
  const run = spawnSync('python3', [join(tool, 'test', 'test_render_a_motion_graphics_overlay.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(-3000));
});
