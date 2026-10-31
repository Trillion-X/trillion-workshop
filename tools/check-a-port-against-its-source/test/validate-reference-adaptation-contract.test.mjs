import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';

const PACKAGE_ROOT = resolve(new URL('..', import.meta.url).pathname);
const VALIDATOR = join(PACKAGE_ROOT, 'do-work/validate-reference-adaptation-contract.mjs');
const multihash = (bytes) => makeHashCodeHexFromBytes(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);

const CRC_TABLE = Array.from({ length: 256 }, (_, seed) => {
  let value = seed;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
}

function writeSolidPng(path, width, height, rgba = [17, 34, 51, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    scanlines[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      for (let channel = 0; channel < 4; channel += 1) scanlines[offset + channel] = rgba[channel];
    }
  }
  const bytes = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, bytes);
  return multihash(bytes);
}

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reference-adaptation-'));
  const sourcePath = join(dir, 'source.tsx');
  const targetPath = join(dir, 'target.tsx');
  const source = Array.from({ length: 20 }, (_, i) => `export const preservedMechanism${i} = () => ${i}; // meaningful source line`).join('\n');
  writeFileSync(sourcePath, source);
  writeFileSync(targetPath, source);
  const digest = multihash(source);
  const base = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-TEST-SOURCE-FIRST', status: 'VERIFIED',
    directive: { thread_id: 'test', message_multihash: `1f:${'a'.repeat(64)}`, quote: 'copy the exact same animation' },
    mode: 'SOURCE_FIRST_PORT',
    sources: [{ path: sourcePath, multihash: digest, ownership: 'repository-owned' }],
    targets: [{ path: targetPath }],
    preserve: ['pane state'], allowed_deltas: ['data labels'], banned_substitutions: ['custom approximation'],
    baseline: { copied_before_adaptation: true, source_multihash: digest, target_multihash_at_baseline: digest, recorded_at: '2026-08-09T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.8, required_mechanisms: ['preservedMechanism1'], test_refs: ['test:unit'], render_refs: ['desktop.png'], originality_ref: null },
  };
  return { dir, sourcePath, targetPath, contract: { ...base, ...overrides } };
}

function visualReplicaFixture({ completionProof = false } = {}) {
  const { dir, targetPath, contract } = fixture({
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-TEST-VISUAL-REPLICA',
    status: completionProof ? 'VERIFIED' : 'BASELINED',
    directive: { thread_id: 'test', message_multihash: `1f:${'b'.repeat(64)}`, quote: 'recreate the measured screenshot geometry' },
    mode: 'VISUAL_REPLICA',
    proof: { test_refs: completionProof ? ['test:visual'] : [], render_refs: ['reference.png'], originality_ref: null },
  });
  const sourcePath = join(dir, 'reference-source.png');
  const cropPath = join(dir, 'reference-crop.png');
  const annotatedPath = join(dir, 'reference-annotated.png');
  const renderPath = join(dir, 'target-render.png');
  const diffPath = join(dir, 'pixel-diff.png');
  const sourceMultihash = writeSolidPng(sourcePath, 64, 48);
  const cropMultihash = writeSolidPng(cropPath, 32, 24);
  const annotatedMultihash = writeSolidPng(annotatedPath, 32, 24);
  const renderMultihash = writeSolidPng(renderPath, 32, 24);
  const diffMultihash = writeSolidPng(diffPath, 32, 24, [0, 0, 0, 0]);
  const bounds = (index) => ({ x_px: index % 8, y_px: index % 6, width_px: 4, height_px: 3 });
  const rows = (count, prefix, make) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index + 1}`, ...make(index) }));
  const lock = {
    schema: 'reference-adaptation-contract/measured-reference-geometry',
    references: [{
      id: 'reference-card',
      source: { path: sourcePath, multihash: sourceMultihash, width: 64, height: 48 },
      crop: { path: cropPath, multihash: cropMultihash, width: 32, height: 24, source_x_px: 8, source_y_px: 6 },
      annotated_proof: { path: annotatedPath, multihash: annotatedMultihash, width: 32, height: 24 },
      landmarks: rows(8, 'landmark', (index) => ({ x_px: index, y_px: index })),
      color_samples: rows(8, 'color', (index) => ({ x_px: index, y_px: index, rgba_hex: '#112233FF' })),
      typography_measurements: rows(5, 'type', (index) => ({ bounds: bounds(index), font_size_px: 12, line_height_px: 16, font_weight: 500, letter_spacing_px: 0 })),
      spacing_measurements: rows(8, 'space', () => ({ axis: 'x', distance_px: 8 })),
      surface_measurements: rows(3, 'surface', (index) => ({ bounds: bounds(index), radius_px: 4, border_width_px: 1, fill_rgba_hex: '#FFFFFFFF' })),
      control_measurements: rows(2, 'control', (index) => ({ bounds: bounds(index), radius_px: 4 })),
    }],
    target_screens: [{
      id: 'target-card',
      reference_id: 'reference-card',
      replica_dimensions: { width: 32, height: 24 },
      element_mappings: rows(8, 'mapping', (index) => ({
        reference_element: `reference-${index + 1}`,
        target_element: `target-${index + 1}`,
        implementation_owner: 'packages/ui/show/card/Card.tsx',
        reference_bounds: bounds(index),
      })),
      ...(completionProof ? {
        render_proof: { path: renderPath, multihash: renderMultihash, width: 32, height: 24 },
        comparison: {
          method: 'mean-absolute-rgba-byte-difference',
          pixel_diff_path: diffPath,
          pixel_diff_multihash: diffMultihash,
          difference_ratio: 0,
          maximum_difference_ratio: 0.03,
        },
      } : {}),
    }],
  };
  const lockPath = join(dir, 'visual-replica-pixel-lock.json');
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  contract.pixel_lock = { path: lockPath, multihash: multihash(readFileSync(lockPath)) };
  return { dir, targetPath, contract, lock, lockPath };
}

test('unit: accepts a valid source-first contract', () => {
  const { contract, targetPath } = fixture();
  const result = validateReferenceAdaptationContract(contract, { stage: 'completion', target: targetPath });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('unit: accepts the package-owned semantic schema', () => {
  const { contract, targetPath } = fixture({
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
  });
  const result = validateReferenceAdaptationContract(contract, { stage: 'completion', target: targetPath });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('unit: accepts the BLAKE3 multihash directive identity', () => {
  const { contract, targetPath } = fixture({
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
  });
  contract.directive = {
    thread_id: 'test',
    message_multihash: `1f:${'b'.repeat(64)}`,
    quote: 'preserve the compact in-product layout',
  };
  const result = validateReferenceAdaptationContract(contract, { stage: 'completion', target: targetPath });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('unit: rejects a directive without a BLAKE3 multihash identity', () => {
  const { contract, targetPath } = fixture();
  contract.directive = { quote: 'preserve the compact in-product layout' };
  const result = validateReferenceAdaptationContract(contract, { stage: 'completion', target: targetPath });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('message_multihash')));
});

test('visual replica: pre-edit requires and accepts complete measured reference geometry', () => {
  const { contract, targetPath } = visualReplicaFixture();
  const result = validateReferenceAdaptationContract(contract, { stage: 'pre-edit', target: targetPath });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.measurements, {
    referenceCount: 1,
    targetScreenCount: 1,
    minimums: {
      landmarks: 8,
      color_samples: 8,
      typography_measurements: 5,
      spacing_measurements: 8,
      surface_measurements: 3,
      control_measurements: 2,
      element_mappings: 8,
    },
  });
});

test('visual replica: pre-edit rejects screenshot viewing without exhaustive measurements', () => {
  const { contract, lock, lockPath } = visualReplicaFixture();
  lock.references[0].landmarks = lock.references[0].landmarks.slice(0, 2);
  lock.references[0].typography_measurements = [];
  lock.target_screens[0].element_mappings = lock.target_screens[0].element_mappings.slice(0, 1);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  contract.pixel_lock.multihash = multihash(readFileSync(lockPath));
  const result = validateReferenceAdaptationContract(contract, { stage: 'pre-edit' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('at least 8 landmarks')));
  assert.ok(result.errors.some((error) => error.includes('at least 5 typography_measurements')));
  assert.ok(result.errors.some((error) => error.includes('at least 8 element_mappings')));
});

test('visual replica: completion requires comparable same-size render and pixel-diff proof', () => {
  const withoutProof = visualReplicaFixture();
  withoutProof.contract.status = 'VERIFIED';
  withoutProof.contract.proof.test_refs = ['test:visual'];
  const rejected = validateReferenceAdaptationContract(withoutProof.contract, { stage: 'completion' });
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.some((error) => error.includes('render_proof')));
  assert.ok(rejected.errors.some((error) => error.includes('pixel comparison proof')));

  const complete = visualReplicaFixture({ completionProof: true });
  const accepted = validateReferenceAdaptationContract(complete.contract, { stage: 'completion', target: complete.targetPath });
  assert.equal(accepted.valid, true, accepted.errors.join('\n'));
});

test('visual replica: detects pixel-lock drift and rejects a declared tolerance above three percent', () => {
  const { contract, lock, lockPath } = visualReplicaFixture({ completionProof: true });
  lock.target_screens[0].comparison.maximum_difference_ratio = 0.031;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const result = validateReferenceAdaptationContract(contract, { stage: 'completion' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('pixel lock multihash drift')));
  assert.ok(result.errors.some((error) => error.includes('maximum_difference_ratio <= 0.03')));
});

test('visual replica: independently measures PNG bytes instead of trusting a declared ratio', () => {
  const { contract, lock, lockPath } = visualReplicaFixture({ completionProof: true });
  lock.target_screens[0].comparison.difference_ratio = 0.02;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  contract.pixel_lock.multihash = multihash(readFileSync(lockPath));
  const result = validateReferenceAdaptationContract(contract, { stage: 'completion' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('does not match measured 0')));
});

test('integration: CLI validates a complete contract file', () => {
  const { dir, contract, targetPath } = fixture();
  const contractPath = join(dir, 'reference-adaptation-contract.json');
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const run = spawnSync(process.execPath, [VALIDATOR, 'validate', contractPath, '--stage', 'completion', '--target', targetPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stdout).valid, true);
});

test('adversarial: an exact-copy directive cannot be relabeled inspiration', () => {
  const { contract } = fixture({ mode: 'INSPIRATION_ONLY' });
  contract.proof.originality_ref = 'proof.md';
  const result = validateReferenceAdaptationContract(contract, { stage: 'completion' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('requires SOURCE_FIRST_PORT')));
});

test('benchmark: one hundred pre-edit validations stay below 500ms', () => {
  const { contract, targetPath } = fixture();
  const started = performance.now();
  for (let i = 0; i < 100; i += 1) assert.equal(validateReferenceAdaptationContract(contract, { stage: 'pre-edit', target: targetPath }).valid, true);
  assert.ok(performance.now() - started < 500);
});

test('fuzz: malformed contract shapes return errors without throwing', () => {
  const values = [null, {}, [], '', 7, { schema: null }, { sources: [null] }, { targets: [{ path: '' }] }];
  for (let i = 0; i < 1000; i += 1) {
    const value = values[i % values.length];
    assert.doesNotThrow(() => validateReferenceAdaptationContract(value, { stage: i % 2 ? 'pre-edit' : 'completion' }));
  }
});

test('determinism: repeated validation returns byte-identical output', () => {
  const { contract, targetPath } = fixture();
  const first = JSON.stringify(validateReferenceAdaptationContract(contract, { stage: 'completion', target: targetPath }));
  for (let i = 0; i < 20; i += 1) assert.equal(JSON.stringify(validateReferenceAdaptationContract(contract, { stage: 'completion', target: targetPath })), first);
});

test('security: detects source drift, target mismatch, and unowned copying', () => {
  const { contract, sourcePath } = fixture();
  writeFileSync(sourcePath, 'tampered source');
  contract.sources[0].ownership = 'reference-only';
  const result = validateReferenceAdaptationContract(contract, { stage: 'completion', target: '/tmp/not-owned.tsx' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('source multihash drift')));
  assert.ok(result.errors.some((error) => error.includes('does not own target')));
  assert.ok(result.errors.some((error) => error.includes('owned or licensed')));
});
