// The Rust crate on synthetic films: the unit and gauntlet tests pass, and the three commands turn a made-up
// two-cell film into bytes that are the same every time. Skips, saying why, when cargo is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifest = join(import.meta.dirname, '..', 'Cargo.toml');
const target = join(tmpdir(), 'pointillist-film-test-build');
const cargo = spawnSync('cargo', ['--version']);
const skip = cargo.status !== 0 && 'cargo is missing';

const cargoArgs = (...rest) => [...rest, '--release', '--quiet', '--manifest-path', manifest, '--target-dir', target];
const example = (name, ...args) => spawnSync('cargo', [...cargoArgs('run'), '--example', name, '--', ...args], { encoding: 'utf8' });

const config = {
  grid: { columns: 2, rows: 1, cell_gap_fraction: 0.1 },
  limits: { max_columns: 8, max_rows: 8, max_cells: 64, max_targets: 4, max_frame_bytes: 4096, max_cell_gap_fraction: 0.4 },
  style: { min_opacity: 0, max_opacity: 1, min_scale: 0, max_scale: 4 },
};
const cell = (r, g, b) => ({ color: { r, g, b, a: 255 }, opacity: 1, scale: 1 });
const script = {
  targets: [{ cells: [cell(250, 0, 0), cell(0, 0, 250)] }, { cells: [cell(0, 250, 0), cell(250, 250, 0)] }],
  segments: [{
    start_seconds: 0,
    duration_seconds: 2,
    samples: [
      { target: 0, weight: { terms: [{ kind: 'constant', value: 1 }], combiner: 'sum' } },
      { target: 1, weight: { terms: [{ kind: 'input' }], combiner: 'sum' } },
    ],
  }],
};

function inTemp(name, body) {
  const dir = mkdtempSync(join(tmpdir(), 'pointillist-film-'));
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(body));
  return { dir, file };
}

test('the crate tests pass: grid, morph, fields, timeline, wire, target animation', { skip, timeout: 900000 }, () => {
  const done = spawnSync('cargo', cargoArgs('test'), { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
});

test('one frame: a packed frame of two cells, the same bytes each time', { skip, timeout: 900000 }, () => {
  const { dir, file } = inTemp('request.json', { config, script, time_seconds: 0.5 });
  const first = join(dir, 'a.pfcf');
  const second = join(dir, 'b.pfcf');
  assert.equal(example('encode_frame_request', file, first).status, 0);
  assert.equal(example('encode_frame_request', file, second).status, 0);
  const bytes = readFileSync(first);
  assert.deepEqual(bytes, readFileSync(second));
  assert.equal(bytes.subarray(0, 4).toString(), 'PFCF');
  assert.equal(bytes.readUInt32LE(6), 2);
  assert.equal(bytes.readUInt32LE(10), 1);
  assert.equal(bytes.readUInt32LE(18), 2);
  assert.equal(bytes.length, 22 + 2 * 16);
});

test('a sequence: one frame file for each time asked', { skip, timeout: 900000 }, () => {
  const { dir, file } = inTemp('sequence.json', { request: { config, script, time_seconds: 0 }, times_seconds: [0, 1, 1.5] });
  const out = join(dir, 'frames');
  assert.equal(example('encode_frame_sequence', file, out).status, 0);
  assert.deepEqual(readdirSync(out).sort(), ['frame-0000.pfcf', 'frame-0001.pfcf', 'frame-0002.pfcf']);
  assert.notDeepEqual(readFileSync(join(out, 'frame-0000.pfcf')), readFileSync(join(out, 'frame-0002.pfcf')));
});

test('a target animation: the same film as a file of target frames', { skip, timeout: 900000 }, () => {
  const { dir, file } = inTemp('animation.json', { config, script, frame_rate: 4 });
  const out = join(dir, 'animation.pfat');
  assert.equal(example('encode_target_animation', file, out).status, 0);
  assert.equal(readFileSync(out).subarray(0, 4).toString(), 'PFAT');
});

test('a request that breaks the limits is refused with a message, and writes nothing', { skip, timeout: 900000 }, () => {
  const { dir, file } = inTemp('bad.json', { config: { ...config, grid: { columns: 99, rows: 1, cell_gap_fraction: 0.1 } }, script, time_seconds: 0 });
  const out = join(dir, 'never.pfcf');
  const done = example('encode_frame_request', file, out);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /columns/);
  assert.deepEqual(readdirSync(dir).sort(), ['bad.json']);
});
