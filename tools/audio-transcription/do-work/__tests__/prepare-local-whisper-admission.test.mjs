import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const packageRoot = new URL('../../', import.meta.url);
const script = new URL('do-work/prepare-local-whisper-admission.py', packageRoot).pathname;
const contract = new URL('runtime/local-whisper/runtime-artifact.json', packageRoot).pathname;
const imageId = `sha256:${'4'.repeat(64)}`;
const digest = `127.0.0.1:5000/bitfield-local-whisper@sha256:${'5'.repeat(64)}`;
const layers = [`sha256:${'6'.repeat(64)}`, `sha256:${'7'.repeat(64)}`];

function prepare(inspect, expected = imageId) {
  const root = mkdtempSync(join(tmpdir(), 'local-whisper-admission-'));
  const inspectPath = join(root, 'inspect.json');
  const sourcePath = join(root, 'source-role.json');
  const selectionPath = join(root, 'selection.json');
  writeFileSync(inspectPath, JSON.stringify(inspect));
  const result = spawnSync('python3', [script, contract, inspectPath, expected, sourcePath, selectionPath], { encoding: 'utf8' });
  const output = result.status === 0 ? {
    source: JSON.parse(readFileSync(sourcePath, 'utf8')),
    selection: JSON.parse(readFileSync(selectionPath, 'utf8')),
  } : null;
  rmSync(root, { recursive: true, force: true });
  return { result, output };
}

test('emits one distinct external alias from exact image ID and loopback RepoDigest', () => {
  const { result, output } = prepare({ Id: imageId, RepoDigests: [digest], RootFS: { Type: 'layers', Layers: layers } });
  assert.equal(result.status, 0, result.stderr);
  const alias = output.source.process_roles[0].process_admission.runtime_aliases['local-whisper'];
  assert.equal(alias.kind, 'external_provider');
  assert.equal(alias.provider.immutable_runtime_artifact, digest);
  assert.equal(alias.network_allowed, false);
  assert.equal(alias.provider.required_capabilities.descendant_lifecycle, true);
  assert.equal(alias.provider.required_capabilities.zero_unowned_descendants, true);
  assert.deepEqual(output.selection.runtime_alias_selections, [{ name: 'local-whisper', mode: 'add_external_provider' }]);
  assert.equal(output.selection.source_descriptor.endsWith('/source-role.json'), true);
});

test('pins the exact local config and ordered layers when RepoDigests are absent', () => {
  const { result, output } = prepare({ Id: imageId, RepoDigests: [], RootFS: { Type: 'layers', Layers: layers } });
  assert.equal(result.status, 0, result.stderr);
  const artifact = output.source.process_roles[0].process_admission.runtime_aliases['local-whisper'].provider.immutable_runtime_artifact;
  assert.equal(artifact, `local-oci-image/rootfs/${layers.join('+')}@${imageId}`);
});

test('accepts exactly one result from the declared generic image reader', () => {
  const inspection = { Id: imageId, RepoDigests: [], RootFS: { Type: 'layers', Layers: layers } };
  const { result, output } = prepare([{ tags: ['bitfield-local-whisper:1.8.3-tiny-en'], admission_inspection: inspection }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    output.source.process_roles[0].process_admission.runtime_aliases['local-whisper'].provider.immutable_runtime_artifact,
    `local-oci-image/rootfs/${layers.join('+')}@${imageId}`,
  );
  assert.notEqual(prepare([
    { admission_inspection: inspection },
    { admission_inspection: inspection },
  ]).result.status, 0);
});

for (const [name, inspect, expected] of [
  ['mutable tag only', { Id: imageId, RepoTags: ['bitfield-local-whisper:latest'] }, imageId],
  ['external registry', { Id: imageId, RepoDigests: [`registry.example/bitfield-local-whisper@sha256:${'5'.repeat(64)}`] }, imageId],
  ['different build result', { Id: `sha256:${'6'.repeat(64)}`, RepoDigests: [digest] }, imageId],
  ['image ID as artifact', { Id: imageId, RepoDigests: [imageId] }, imageId],
  ['missing layer identities', { Id: imageId, RepoDigests: [], RootFS: { Type: 'layers', Layers: [] } }, imageId],
  ['changed layer identity', { Id: imageId, RepoDigests: [], RootFS: { Type: 'layers', Layers: [`sha256:${'A'.repeat(64)}`] } }, imageId],
  ['non-layer root filesystem', { Id: imageId, RepoDigests: [], RootFS: { Type: 'other', Layers: layers } }, imageId],
]) {
  test(`refuses ${name}`, () => assert.notEqual(prepare(inspect, expected).result.status, 0));
}

test('the retry profile keeps the immutable saved-media mount and request identity binding', () => {
  const manifest = JSON.parse(readFileSync(new URL('things-to-store-and-run.json', packageRoot), 'utf8'));
  const profile = manifest.things.find((thing) => thing?.payload?.profile_id === 'local-whisper').payload;
  const retry = manifest.things.find((thing) => thing?.payload?.id === 'action:auto-transcribe-recorded-media').payload;
  const descriptor = profile.capability.params.process_descriptor_template;
  const media = descriptor.inputs.find((input) => input.mount_path === 'media/source');
  assert.equal(descriptor.argv[0], 'local-whisper');
  assert.equal(descriptor.argv[3].select.path, 'request_id');
  assert.equal(media.source.kind, 'blob_ref');
  assert.equal(media.source.hash.select.path, 'source.artifact_ref.cas_address');
  assert.equal(descriptor.containment.kind, 'descendant_effect_contained');
  assert.deepEqual(retry.steps[0].config.inputs.request_id.transform[0].args.values, [
    'auto:',
    { $kind: 'binding', select: { from: 'input', path: 'recorded_file_id' } },
  ]);
  assert.deepEqual(retry.steps[0].config.inputs.source, {
    $kind: 'binding',
    select: { from: 'input', path: 'source' },
  });
});
