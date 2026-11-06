// tools/render-a-motion-graphics-overlay: tool:render-an-overlay-insert-for-a-cut. The command reads the shots, the film's
// look row and the claim check's settings row from made-up rows of list:settings in a stand-in records door; then the
// command renders a made-up shot's stills from them; the Python tests (every output, quick, audio_only, a batch under the
// lock, the claim-check refusal) run beside it. Needs python3 with Pillow, numpy and OpenCV, and ffmpeg with prores_ks and
// libx264; without them those tests are skipped with the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
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
const row = (id, scope_kind, scope_id, settings, tool = `tool:${FOLDER}`) => ({ id, type: 'record:setting', value: {
  name: `${scope_id}`, tool, scope_kind, scope_id, settings, from: 'made-up@0000000', status: 'active' } });
const RIGHTS = [{ kind: 'record:setting', prefix: `record:setting:${FOLDER}~`, operations: ['records:read'] },
  { kind: 'record:setting', prefix: `record:setting:${CLAIMS_FOLDER}~`, operations: ['records:read'] }];
const lookRow = insertSection => makeRecord(FOLDER, 'film', 'sample-film.corrections', { ...look, insert: insertSection },
  { name: 'made-up corrections look', tool: `tool:${FOLDER}`, source: 'made-up@0000000' });

async function withDoor(records, fn) {
  const fake = await startFakeDoor({ rights: RIGHTS, records });
  try { return await fn(openRecordsDoor({ descriptor: fake.descriptor })); } finally { await fake.close?.(); }
}

test('withRows reads a batch of shots, the look row and the claim check row named in the look', async () => {
  const claims = row(CLAIMS_ID, 'film', 'sample-film', { rules: {} }, `tool:${CLAIMS_FOLDER}`);
  await withDoor([lookRow({ claim_check: { lane_dir: '/made/up', settings_record: CLAIMS_ID } }), claims,
    row(pieceId('shot-a'), 'piece', 'shot-a', { spec: shot('shot-a') }), row(pieceId('shot-b'), 'piece', 'shot-b', { spec: shot('shot-b') })], async door => {
    const got = await withRows({ settings_record: LOOK_ID, spec_records: [pieceId('shot-a'), pieceId('shot-b')], out: 'x' }, door);
    assert.deepEqual(got.specs.map(s => s.id), ['shot-a', 'shot-b']);
    assert.deepEqual(got.specs_from, [pieceId('shot-a'), pieceId('shot-b')]);
    assert.equal(got.settings_record.id, LOOK_ID, 'the look row is handed as the record');
    assert.equal(got.claim_check.lane_dir, '/made/up');
    assert.equal(got.claim_check.settings_record.id, CLAIMS_ID, 'the claim check row is read through the door');
    const own = await withRows({ settings_record: LOOK_ID, spec: shot('s'), claim_check: { skip: 'no claim' } }, door);
    assert.deepEqual(own.claim_check, { skip: 'no claim' }, 'the request\'s own claim_check wins over the look\'s');
    await assert.rejects(withRows({ spec_records: [], out: 'x' }, door), /non-empty list/);
    await assert.rejects(withRows({ spec_records: [pieceId('shot-a')], spec: shot('s') }, door), /one of spec/);
    await assert.rejects(withRows({ settings_record: `record:setting:${FOLDER}~film~absent`, spec: shot('s') }, door), /write the film's look row first/);
    await assert.rejects(withRows({ spec: shot('s'), claim_check: { settings_record: `record:setting:${CLAIMS_FOLDER}~film~absent` } }, door), /write the claim check's row first/);
    await assert.rejects(withRows({ spec: shot('s'), claim_check: { settings_record: `record:setting:${FOLDER}~film~x` } }, door), /belongs to tools/);
  });
});

test('the command renders a batch of pieces from the corrections look row', { skip: missing, timeout: 300_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'insert-'));
  try {
    await withDoor([lookRow({ claim_check: { skip: 'made-up shots make no claim' } }), row(pieceId('shot-a'), 'piece', 'shot-a', { spec: shot('shot-a') }),
      row(pieceId('shot-b'), 'piece', 'shot-b', { spec: shot('shot-b') })], async door => {
      let printed = '';
      const sink = new Writable({ write(chunk, _e, done) { printed += chunk; done(); } });
      const request = { settings_record: LOOK_ID, spec_records: [pieceId('shot-a'), pieceId('shot-b')], assets: example, out, stills: [0.2] };
      const code = await renderInsert({ stdin: Readable.from([JSON.stringify(request)]), door, out: sink });
      assert.equal(code, 0, printed);
      const { result } = JSON.parse(printed.trim().split('\n').at(-1));
      assert.deepEqual(result.inserts.map(i => i.id), ['shot-a', 'shot-b']);
      assert.deepEqual(result.inserts[0].claim_check, ['shot-a: claim check skipped: made-up shots make no claim']);
      assert.ok(existsSync(join(out, 'shot-b', 'still-00.20.jpg')));
    });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the Python tests of the insert pass (every output, quick, audio_only, a batch, the claim check)', { skip: missing, timeout: 1_800_000 }, () => {
  const run = spawnSync('python3', [join(tool, 'test', 'test_render_an_overlay_insert.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(-3000));
});
