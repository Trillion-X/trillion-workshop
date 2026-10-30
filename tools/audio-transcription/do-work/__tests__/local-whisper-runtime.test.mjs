import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageRoot = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('things-to-store-and-run.json', packageRoot), 'utf8'));
const runtime = JSON.parse(readFileSync(new URL('runtime/local-whisper/runtime-artifact.json', packageRoot), 'utf8'));
const dockerfile = readFileSync(new URL('runtime/local-whisper/Dockerfile', packageRoot), 'utf8');
const profile = manifest.things.find((thing) => thing?.payload?.profile_id === 'local-whisper')?.payload;
const descriptor = profile?.capability?.params?.process_descriptor_template;

test('local transcription selects only the contained external runtime', () => {
  assert.equal(descriptor.argv[0], 'local-whisper');
  assert.equal(descriptor.containment.kind, 'descendant_effect_contained');
  assert.equal(runtime.runtime.network_allowed, false);
  assert.equal(runtime.artifact_admission.native_fallback, false);
  assert.equal(runtime.provider.provider_id, 'local-oci-engine');
  assert.equal(runtime.provider.provider_protocol_revision, 'bitfield.oci-engine-api/v1');
  assert.deepEqual(runtime.provider.required_capabilities, {
    persistent_session: true,
    descendant_lifecycle: true,
    exclusive_private_volume_lease: true,
    correlated_output: true,
    cleanup: true,
    zero_unowned_descendants: true,
  });
});

test('the profile and image contract agree on every executable and model path', () => {
  assert.equal(runtime.provider.provider_entrypoint[0], runtime.runtime.required_paths.python3);
  assert.equal(descriptor.env.BITFIELD_FFMPEG_PATH, runtime.runtime.required_paths.ffmpeg);
  assert.equal(descriptor.env.BITFIELD_WHISPER_CLI_PATH, runtime.runtime.required_paths.whisper_cli);
  assert.equal(descriptor.env.BITFIELD_WHISPER_MODEL_PATH, runtime.runtime.required_paths.model);
  assert.equal('BITFIELD_WHISPER_MODEL_URL' in descriptor.env, false);
});

test('the image source and model are hash-pinned and runtime does not fetch either', () => {
  assert.match(dockerfile, /FROM docker\.io\/library\/python:3\.12-slim-bookworm@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /WHISPER_CPP_SHA256=[0-9a-f]{64}/);
  assert.match(dockerfile, /WHISPER_MODEL_SHA256=[0-9a-f]{64}/);
  assert.match(dockerfile, /sha256sum --check --strict/g);
  assert.match(dockerfile, /COPY --from=whisper-builder \/opt\/whisper \/opt\/whisper/);
  assert.doesNotMatch(dockerfile.split(/^FROM /m).at(-1), /curl|huggingface|github\.com/);
});

test('the selected CLI build does not invoke Whisper global install targets', () => {
  assert.match(dockerfile, /--target whisper-cli/);
  assert.doesNotMatch(dockerfile, /cmake --install/);
  assert.match(dockerfile, /build\/bin\/whisper-cli \/opt\/whisper\/bin\/whisper-cli/);
  for (const library of ['libwhisper', 'libggml', 'libggml-base', 'libggml-cpu']) {
    assert.match(dockerfile, new RegExp(`test -f /opt/whisper/lib/${library.replace('-', '\\-')}\\.so`));
  }
});

test('the final runtime verifies its model and both executables after copying', () => {
  const finalStage = dockerfile.split(/^FROM /m).at(-1);
  assert.match(finalStage, /sha256sum --check --strict/);
  assert.match(finalStage, /\/usr\/bin\/ffmpeg -version/);
  assert.match(finalStage, /\/opt\/whisper\/bin\/whisper-cli --help/);
  assert.match(finalStage, /ldd \/opt\/whisper\/bin\/whisper-cli/);
});

test('artifact admission cannot be satisfied by a mutable tag or invented digest', () => {
  assert.equal(runtime.artifact_admission.digest_is_filled_only_from_container_engine_build_result, true);
  assert.match(runtime.artifact_admission.required_reference_shape, /@sha256:/);
  assert.equal(Object.hasOwn(runtime.provider, 'immutable_runtime_artifact'), false);
});

test('the existing local binding projector adds one distinct alias', () => {
  assert.equal(runtime.local_process_role_projection.projector, 'packages/native-artifact/do-work/apply-local-process-role-binding.py');
  assert.equal(runtime.local_process_role_projection.selection_schema, 'bitfield.local_process_role_provider_binding_selection');
  assert.deepEqual(runtime.local_process_role_projection.runtime_alias_selection, {
    name: 'local-whisper',
    mode: 'add_external_provider',
  });
});

test('admission accepts a loopback RepoDigest or exact local config and layer identity', () => {
  const promotion = runtime.local_registry_promotion;
  assert.equal(promotion.status, 'optional_when_the_local_config_and_ordered_layers_are_exactly_pinned');
  assert.match('127.0.0.1:5000/bitfield-local-whisper', new RegExp(promotion.repository_must_match));
  assert.doesNotMatch('registry.example/bitfield-local-whisper', new RegExp(promotion.repository_must_match));
  assert.match('localhost:5000/bitfield-local-whisper@sha256:'.concat('a'.repeat(64)), new RegExp(promotion.required_result.repo_digest_must_match));
  assert.ok(promotion.refuse.includes('image ID used as artifact digest'));
  assert.equal(runtime.artifact_admission.local_image_identity.config_digest_source, 'inspect.Id');
  assert.equal(runtime.artifact_admission.local_image_identity.ordered_layer_identity_source, 'inspect.RootFS.Layers');
  assert.equal(runtime.artifact_admission.local_image_identity.absence_is_never_pulled_or_substituted, true);
});
