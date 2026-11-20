// tools/render-a-motion-graphics-overlay: tool:render-an-overlay-insert-for-a-cut. The command takes the shots, the film's
// look row and the claim check's settings row in the request, with no records door; then the
// command renders a made-up shot's stills from them; the Python tests (every output, quick, audio_only, a batch under the
// lock, the claim-check refusal) run beside it. Needs python3 with Pillow, numpy and OpenCV, and ffmpeg with prores_ks and
// libx264; without them those tests are skipped with the reason.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import rows from '../tool-rows.json' with { type: 'json' };
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { renderInsert, withRows, CLAIMS_FOLDER } from '../do-work/render-insert.mjs';
import { FOLDER } from '../do-work/render-overlay.mjs';
import { makeRecord } from '../../settings/read-data/settings.mjs';

const tool = fileURLToPath(new URL('..', import.meta.url));
const example = join(tool, 'read-data', 'example-look');
const look = JSON.parse(readFileSync(join(example, 'look.json'), 'utf8'));
const probe = spawnSync('python3', ['-c', 'import PIL, numpy, cv2'], { encoding: 'utf8' });
const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const missing = probe.status !== 0 ? `needs python3 with Pillow, numpy and OpenCV (${(probe.stderr || '').trim().split('\n').at(-1)})`
  : ffmpeg.status !== 0 || !/prores_ks/.test(ffmpeg.stdout) || !/libx264/.test(ffmpeg.stdout) ? 'needs ffmpeg with prores_ks and libx264' : false;

const LOOK_ID = `record:setting:${FOLDER}~film~sample-film.corrections`;
const CLAIMS_ID = `record:setting:${CLAIMS_FOLDER}~film~sample-film`;
const shot = id => ({ id, canvas: [256, 256], cutout: { image: 'paper.png' }, plate: { source: 'none.mp4', frame: 0 },
  graded_frame: { export: 'none.mp4', cut_frame: 0 }, cut_insert_s: 0, events: [{ type: 'pause', at: 0 }, { type: 'exit', at: 0.6 }] });
const pieceId = id => `record:setting:${FOLDER}~piece~${id}`;
const lookRow = insertSection => makeRecord(FOLDER, 'film', 'sample-film.corrections', { ...look, insert: insertSection },
  { name: 'made-up corrections look', tool: `tool:${FOLDER}`, source: 'made-up@0000000' });

test('withRows takes a batch of shots, the look row and the claim check row in the request and refuses row ids', () => {
  const claims = makeRecord(CLAIMS_FOLDER, 'film', 'sample-film', { rules: {} }, { name: 'made-up claim rules', tool: `tool:${CLAIMS_FOLDER}`, source: 'made-up@0000000' });
  const fullLook = lookRow({ claim_check: { lane_dir: '/made/up', settings_record: claims } });
  const got = withRows({ settings_record: fullLook, specs: [shot('shot-a'), shot('shot-b')], out: 'x' });
  assert.deepEqual(got.specs.map(s => s.id), ['shot-a', 'shot-b']);
  assert.equal(got.settings_record.id, LOOK_ID, 'the look row is handed as the record');
  const own = withRows({ settings_record: fullLook, spec: shot('s'), claim_check: { skip: 'no claim' } });
  assert.deepEqual(own.claim_check, { skip: 'no claim' }, 'the request\'s own claim_check is the one used');
  assert.throws(() => withRows({ specs: [], out: 'x' }), /non-empty list/);
  assert.throws(() => withRows({ specs: [shot('a')], spec: shot('s') }), /one of spec or specs/);
  assert.throws(() => withRows({ spec_records: [pieceId('shot-a')] }), /spec_record and spec_records are not read here/);
  assert.throws(() => withRows({ settings_record: LOOK_ID, spec: shot('s') }), /settings_record is a row's id: give the row itself/);
  assert.throws(() => withRows({ spec: shot('s'), claim_check: { settings_record: CLAIMS_ID } }), /claim_check.settings_record is a row's id/);
  assert.throws(() => withRows({ settings_record: lookRow({ claim_check: { settings_record: CLAIMS_ID } }), spec: shot('s') }), /claim_check.settings_record is a row's id/);
});

test('the row holds no records door and takes the rows themselves', () => {
  const row = rowOf(rows, 'tool:render-an-overlay-insert-for-a-cut');
  assert.equal(row.invoke.records, undefined);
  assert.doesNotMatch(JSON.stringify(row.invoke.files), /records-door|run-with-settings/, 'nothing reads the setting for the tool: no records door and no settings wrapper are packed');
  assert.equal(row.input_schema.properties.spec_record, undefined);
  assert.equal(row.input_schema.properties.spec_records, undefined);
  assert.equal(row.input_schema.properties.settings_record.type, 'object');
});

test('the command renders a batch of shots from the corrections look row', { skip: missing, timeout: 300_000 }, async () => {
  const out = tempFolder(join(tmpdir(), 'insert-'));
  try {
    let printed = '';
    const sink = new Writable({ write(chunk, _e, done) { printed += chunk; done(); } });
    const request = { settings_record: lookRow({ claim_check: { skip: 'made-up shots make no claim' } }), specs: [shot('shot-a'), shot('shot-b')], assets: example, out, stills: [0.2] };
    const code = await renderInsert({ stdin: Readable.from([JSON.stringify(request)]), out: sink });
    assert.equal(code, 0, printed);
    const { result } = JSON.parse(printed.trim().split('\n').at(-1));
    assert.deepEqual(result.inserts.map(i => i.id), ['shot-a', 'shot-b']);
    assert.deepEqual(result.inserts[0].claim_check, ['shot-a: claim check skipped: made-up shots make no claim']);
    assert.ok(existsSync(join(out, 'shot-b', 'still-00.20.jpg')));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the Python tests of the insert pass (every output, quick, audio_only, a batch, the claim check)', { skip: missing, timeout: 1_800_000 }, () => {
  const run = spawnSync('python3', [join(tool, 'test', 'test_render_an_overlay_insert.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(-3000));
});
