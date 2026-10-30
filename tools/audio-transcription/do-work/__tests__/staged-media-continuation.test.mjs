import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../../things-to-store-and-run.json', import.meta.url), 'utf8'));
const trigger = manifest.things.find(
  (thing) => thing?.payload?.id === 'trigger:audio-transcription:auto-transcribe-on-stored-media',
)?.payload;
const profile = manifest.things.find(
  (thing) => thing?.payload?.profile_id === 'local-whisper',
)?.payload;

function at(value, path) {
  return path.split('.').reduce((current, segment) => current?.[segment], value) ?? null;
}

function evaluate(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.$kind !== 'binding') return value;
  let selected = value.select ? context[value.select.from] : null;
  if (value.select?.key) selected = selected?.[value.select.key];
  let result = value.select ? at(selected, value.select.path) : null;
  for (const transform of value.transform ?? []) {
    if (transform.op === 'op:core.equals') result = result === evaluate(transform.args.value, context);
    else if (transform.op === 'op:core.not_equals') result = result !== evaluate(transform.args.value, context);
    else if (transform.op === 'op:core.starts_with') result = typeof result === 'string' && result.startsWith(transform.args.prefix);
    else if (transform.op === 'op:core.or') result = transform.args.values.some((candidate) => Boolean(evaluate(candidate, context)));
    else if (transform.op === 'op:core.and') result = transform.args.values.every((candidate) => Boolean(evaluate(candidate, context)));
    else if (transform.op === 'op:core.concat') result = transform.args.values.map((candidate) => evaluate(candidate, context)).join('');
    else if (transform.op === 'op:core.replace') result = String(result).replaceAll(transform.args.find, transform.args.replace);
    else throw new Error(`unsupported test operator ${transform.op}`);
  }
  return result;
}

function matches(change, envelope = { is_retraction: false }) {
  return trigger.match_condition.conditions.every((condition) => Boolean(evaluate(condition, { change, envelope })));
}

function render(value, context) {
  if (Array.isArray(value)) return value.map((item) => render(item, context));
  if (!value || typeof value !== 'object') return value;
  if (value.$kind === 'binding') return evaluate(value, context);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, context)]));
}

function relation(overrides = {}) {
  const hash = overrides.hash ?? '1f:source-revision-one';
  return {
    kind: 'content-media.relation.record',
    relation_id: overrides.relation_id ?? 'package::content-media-evidence::relation::local-scope::source-revision-one',
    role_ref: { id: 'stored-media' },
    source_ref: {
      artifact_ref: {
        kind: 'canonical-artifact-ref/v1',
        integrity_hash: hash,
        payload_address: hash,
        payload_address_mode: 'addressed_chunks',
        byte_length: 920001,
        media_type: overrides.media_type ?? 'video/mp4',
        display_name: 'Selected video.mp4',
        provenance: { source_kind: 'stable-local-file' },
      },
    },
    context_ref: { subject_ref: 'local-session:opaque', materialized_at: '2026-09-12T18:00:00.000Z' },
    idempotency_ref: overrides.relation_id ?? 'source-revision-one',
    ...overrides,
  };
}

test('first successful stored audio/video relation dispatches without inventing a recording time', () => {
  assert.ok(trigger);
  assert.equal(trigger.dispatch.delivery, 'later_with_durable_outcome');
  for (const media_type of ['video/mp4', 'audio/wav']) {
    const change = relation({ media_type, context_ref: { subject_ref: 'local-session:opaque' } });
    assert.equal(matches(change), true);
    const dispatch = render(trigger.dispatch.output_template, { change, envelope: { is_retraction: false } });
    assert.equal(dispatch.definition_id, 'action:auto-transcribe-recorded-media');
    assert.equal(dispatch.input.recorded_file_id, change.relation_id);
    assert.equal(Object.hasOwn(dispatch.input, 'recorded_at'), false);
    assert.deepEqual(dispatch.input.source, change.source_ref);
    const correlation = render(trigger.dispatch.outcome_correlation_template, {
      change, envelope: { is_retraction: false },
    });
    assert.deepEqual(correlation, {
      relation_id: change.relation_id,
      source_revision: change.source_ref.artifact_ref.integrity_hash,
      request_id: `auto:${change.relation_id}`,
      result_ref: `package::audio-transcription::result::auto:${change.relation_id.replaceAll('%', '_')}`,
    });
  }
});

test('exact replay keeps one request identity while a changed source revision continues independently', () => {
  const dispatched = new Set();
  const accept = (change) => {
    if (!matches(change)) return;
    const request = render(trigger.dispatch.output_template, { change, envelope: { is_retraction: false } });
    dispatched.add(request.input.recorded_file_id);
  };
  const first = relation();
  accept(first);
  accept(structuredClone(first));
  accept(relation({ relation_id: 'package::content-media-evidence::relation::local-scope::source-revision-two', hash: '1f:source-revision-two' }));
  assert.deepEqual([...dispatched], [
    'package::content-media-evidence::relation::local-scope::source-revision-one',
    'package::content-media-evidence::relation::local-scope::source-revision-two',
  ]);
});

test('automatic replay returns only the exact saved result before any process or write step', () => {
  const automated = manifest.things.find(
    (thing) => thing?.payload?.id === 'action:auto-transcribe-recorded-media',
  )?.payload;
  const submit = manifest.things.find(
    (thing) => thing?.payload?.id === 'action:submit-audio-transcription-request',
  )?.payload;
  const sourceRelation = relation({
    relation_id: 'package::content-media-evidence::relation::authority-scope%3A1f%3A47a8::relation%3A1f%3A35f2',
    hash: '1f:exact-source-revision',
  });
  const submitted = render(automated.steps[0].config.inputs, {
    input: { recorded_file_id: sourceRelation.relation_id, source: sourceRelation.source_ref },
  });
  assert.equal(
    submitted.existing_result_ref,
    'package::audio-transcription::result::auto:package::content-media-evidence::relation::authority-scope_3A1f_3A47a8::relation_3A1f_3A35f2',
  );

  const exact = {
    kind: 'audio-transcription.result',
    request_id: submitted.request_id,
    source_fingerprint: '1f:exact-source-revision',
    source_artifact_ref: submitted.source.artifact_ref,
  };
  assert.equal(submitted.request_id, `auto:${sourceRelation.relation_id}`);
  assert.equal(submitted.source.artifact_ref.integrity_hash, exact.source_fingerprint);
  const readOutgoing = submit.edges.filter((edge) => edge.from === 'read_existing_result');
  const destinations = (edges, output) => edges
    .filter((edge) => Boolean(evaluate(edge.config, { input: { output } })))
    .map((edge) => edge.to);
  assert.deepEqual(destinations(readOutgoing, exact), ['verify_existing_result']);
  assert.deepEqual(destinations(readOutgoing, { kind: 'audio-transcription.result-missing' }), ['read_profile']);

  const verify = submit.steps.find((step) => step.id === 'verify_existing_result');
  assert.equal(verify.config.name, 'slot::formula-engine');
  const formula = verify.config.input.binding.value;
  assert.deepEqual(formula.select, { from: 'context', path: 'existing_kind' });
  const formulaResult = (output) => evaluate(formula, {
    context: render(verify.config.input.context, {
      input: submitted,
      steps: { read_existing_result: { output } },
    }),
  });
  assert.equal(formulaResult(exact), true);
  assert.equal(formulaResult({ ...exact, request_id: 'auto:other' }), false);
  assert.equal(formulaResult({
    ...exact,
    source_fingerprint: '1f:changed-source',
    source_artifact_ref: { ...exact.source_artifact_ref, integrity_hash: '1f:changed-source' },
  }), false);

  const verifyOutgoing = submit.edges.filter((edge) => edge.from === 'verify_existing_result');
  assert.deepEqual(destinations(verifyOutgoing, { result: true }), ['return_existing_result']);
  assert.deepEqual(destinations(verifyOutgoing, { result: false }), ['refuse_mismatched_existing_result']);
  assert.equal(submit.edges.some((edge) => edge.from === 'return_existing_result'), false);
  assert.equal(submit.steps.find((step) => step.id === 'read_existing_result').config.fallback_output.kind,
    'audio-transcription.result-missing');

  const automatedDone = automated.steps.find((step) => step.id === 'done');
  assert.equal(automatedDone.config.value.select.key, 'submit_profile_request');
  assert.equal(automatedDone.config.value.select.path, 'output');
  assert.equal(automated.edges.some(
    (edge) => edge.from === 'submit_profile_request' && edge.to === 'done',
  ), true);

  const writtenRead = submit.steps.find((step) => step.id === 'read_written_result');
  assert.equal(writtenRead.config.from.select.path, 'existing_result_ref');
  assert.equal(writtenRead.config.fallback_output.kind, 'audio-transcription.result-missing');
  const writtenVerify = submit.steps.find((step) => step.id === 'verify_written_result');
  assert.equal(writtenVerify.config.name, 'slot::formula-engine');
  assert.equal(writtenVerify.config.input.context.expected_request_id.select.path, 'request_id');
  assert.equal(writtenVerify.config.input.context.expected_source_artifact_ref.select.path, 'source.artifact_ref');
  assert.equal(submit.edges.some(
    (edge) => edge.from === 'write_records' && edge.to === 'read_written_result',
  ), true);
  assert.equal(submit.edges.some(
    (edge) => edge.from === 'read_written_result' && edge.to === 'verify_written_result',
  ), true);
});

test('every replay branch binding passes the runtime-required select-or-expr shape', () => {
  const submit = manifest.things.find(
    (thing) => thing?.payload?.id === 'action:submit-audio-transcription-request',
  )?.payload;
  const malformed = [];
  const visit = (value, path) => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}.${index}`));
    if (!value || typeof value !== 'object') return;
    if (value.$kind === 'opaque-json') return;
    if (value.$kind === 'binding' && !value.select && !value.expr) malformed.push(path);
    for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
  };
  submit.edges.forEach((edge, index) => visit(edge.config, `edges.${index}.config`));
  assert.deepEqual(malformed, []);
});

test('a transient transcription failure can retry without making a second request identity', () => {
  const change = relation();
  const requests = [];
  let attempts = 0;
  const consume = () => {
    const request = render(trigger.dispatch.output_template, { change, envelope: { is_retraction: false } });
    requests.push(`auto:${request.input.recorded_file_id}`);
    attempts += 1;
    if (attempts === 1) throw new Error('transient contained worker failure');
    return request;
  };
  assert.throws(consume, /transient contained worker failure/);
  assert.equal(consume().definition_id, 'action:auto-transcribe-recorded-media');
  assert.deepEqual(requests, [
    'auto:package::content-media-evidence::relation::local-scope::source-revision-one',
    'auto:package::content-media-evidence::relation::local-scope::source-revision-one',
  ]);
});

test('retractions, failures, incomplete relations and non-transcribable media do not dispatch', () => {
  assert.equal(matches(relation(), { is_retraction: true }), false);
  assert.equal(matches(relation({ error_ref: { code: 'read-failed' } })), false);
  assert.equal(matches(relation({ source_ref: {} })), false);
  assert.equal(matches(relation({ role_ref: { id: 'preview' } })), false);
  assert.equal(matches(relation({ relation_id: '' })), false);
  assert.equal(matches(relation({ media_type: 'image/png' })), false);
});

test('the stored-media trigger is registered in the package factflow', () => {
  const factflow = manifest.things.find(
    (thing) => thing?.payload?.kind === 'bitfield-eeaf-factflow',
  )?.payload;
  assert.ok(factflow.fact_sources.some(
    (source) => source.address === 'package::audio-transcription::trigger-rule::auto-transcribe-on-stored-media',
  ));
});

test('the existing transcription profile consumes the canonical stored-media identity and type', () => {
  const mediaInput = profile.capability.params.process_descriptor_template.inputs.find(
    (input) => input.mount_path === 'media/source',
  );
  assert.equal(
    mediaInput.content_type.transform[0].args.fallback.select.path,
    'source.artifact_ref.media_type',
  );
  assert.equal(
    mediaInput.source.hash.transform[0].args.fallback.transform[0].args.fallback.select.path,
    'source.artifact_ref.integrity_hash',
  );
});

test('the request reads its declared profile by exact identity text', () => {
  const submit = manifest.things.find(
    (thing) => thing?.payload?.id === 'action:submit-audio-transcription-request',
  )?.payload;
  const readProfile = submit?.steps?.find((step) => step.id === 'read_profile');
  assert.equal(readProfile?.kind, 'read');
  assert.equal(readProfile?.config?.address_mode, 'identity_text');
  assert.equal(readProfile?.config?.from?.select?.path, 'profile_ref');
});

test('the audio surface reads the exact input declared by its package', () => {
  const inputName = manifest.things.find(
    (thing) => thing?.address === 'package::audio-transcription::input::contentMediaEvidence',
  )?.payload?.input_name;
  const surface = readFileSync(new URL('../../show/AudioTranscriptionPanel.tsx', import.meta.url), 'utf8');
  assert.equal(inputName, 'audio-transcription:contentMediaEvidence');
  assert.match(surface, /useBitfieldData\('audio-transcription:contentMediaEvidence'\)/);
  assert.doesNotMatch(surface, /useBitfieldData\('contentMediaEvidence'\)/);
});

test('automated submission keeps event time optional while manual submissions may provide it', () => {
  const submit = manifest.things.find(
    (thing) => thing?.payload?.id === 'action:submit-audio-transcription-request',
  )?.payload;
  const automated = manifest.things.find(
    (thing) => thing?.payload?.id === 'action:auto-transcribe-recorded-media',
  )?.payload;
  assert.ok(submit);
  assert.ok(automated);
  assert.equal(submit.input_schema.required.includes('requested_at'), false);
  assert.equal(submit.input_schema.properties.requested_at.type, 'string');
  assert.deepEqual(automated.input_schema.required, ['recorded_file_id', 'source']);
  assert.equal(Object.hasOwn(automated.steps[0].config.inputs, 'requested_at'), false);
});

test('the continuation check is declared by its package', () => {
  const checks = manifest.things.find(
    (thing) => thing?.payload?.kind === 'package-checks-descriptor',
  )?.payload?.checks;
  assert.ok(checks.includes('do-work/__tests__/staged-media-continuation.test.mjs'));
});

test('the result owner preserves relation identity without inventing a completion time', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'audio-transcription-result-'));
  try {
    const requestPath = join(scratch, 'request.json');
    const commandPath = join(scratch, 'command.json');
    const outputPath = join(scratch, 'output.json');
    writeFileSync(requestPath, JSON.stringify({
      request_id: 'auto:package::content-media-evidence::relation::local-scope::source-revision-one',
      source: relation().source_ref,
    }));
    writeFileSync(commandPath, JSON.stringify({ full_text: 'Verified extractive words.' }));
    const run = spawnSync('python3', [
      new URL('../process-scripts/make-audio-transcription-records-from-command-output.py', import.meta.url).pathname,
      '--request-json', requestPath,
      '--command-output-json', commandPath,
      '--output-json', outputPath,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(outputPath, 'utf8')).records[0].payload;
    assert.equal(result.request_id, 'auto:package::content-media-evidence::relation::local-scope::source-revision-one');
    assert.equal(result.source_fingerprint, '1f:source-revision-one');
    assert.equal(result.source_artifact_ref.integrity_hash, '1f:source-revision-one');
    assert.equal(result.completed_at, '');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
