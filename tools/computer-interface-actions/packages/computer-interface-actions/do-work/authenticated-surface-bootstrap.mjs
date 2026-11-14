import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PORTABLE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTENT_HASH = /^1f:[0-9a-f]{64}$/;
const BOOTSTRAP_ID = /^computer-interface-bootstrap:[A-Za-z0-9_-]+$/;
const MAX_OBSERVATION_BYTES = 8192;
const OBSERVATION_KIND = 'computer-interface.authenticated-surface-observation';
const PROOF_KIND = 'computer-interface.authenticated-surface-proof';

export class AuthenticatedSurfaceBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthenticatedSurfaceBootstrapError';
    this.code = code;
  }
}

/**
 * Plan a provider-declared neutral surface bootstrap. The caller cannot supply
 * argv, a URL, browser code, an account/profile, or an existing session id.
 */
export function prepareAuthenticatedSurfaceBootstrap(request, providersDoc) {
  assertExactObject(request, ['provider_id', 'task_ref', 'idempotency_key'], 'invalid_bootstrap_request');
  const provider = findProvider(request.provider_id, providersDoc);
  if (provider.surface_class !== 'task_isolated_agent_screen') {
    throw failure('provider_not_isolated', 'This browsing option cannot create a separate screen for this task.');
  }
  const bootstrap = provider.authenticated_surface_bootstrap;
  assertExactObject(bootstrap, [
    'version', 'argv', 'run_timeout_ms', 'network_access', 'containment', 'observation_kind', 'terminal_attestation',
  ], 'bootstrap_not_declared');
  if (bootstrap.version !== 1 || bootstrap.observation_kind !== OBSERVATION_KIND) {
    throw failure('invalid_bootstrap_data', 'The separate browsing screen setup is incomplete.');
  }
  if (!Array.isArray(bootstrap.argv) || bootstrap.argv.length === 0 || !bootstrap.argv.every(portableArgument)) {
    throw failure('invalid_bootstrap_data', 'The separate browsing screen setup is incomplete.');
  }
  if (!PORTABLE_ALIAS.test(provider.executable ?? '')) {
    throw failure('invalid_bootstrap_data', 'The separate browsing screen setup is incomplete.');
  }
  if (!Number.isSafeInteger(bootstrap.run_timeout_ms) || bootstrap.run_timeout_ms <= 0 || bootstrap.run_timeout_ms > 300000) {
    throw failure('invalid_bootstrap_data', 'The separate browsing screen setup is incomplete.');
  }
  if (bootstrap.network_access !== 'allowed') {
    throw failure('invalid_bootstrap_data', 'The separate browsing screen setup is incomplete.');
  }
  validateTerminalAttestation(bootstrap.terminal_attestation);
  const taskRef = nonEmpty(request.task_ref, 'invalid_task_ref');
  const requestKey = nonEmpty(request.idempotency_key, 'missing_idempotency_key');
  const intent = {
    version: 1,
    provider_id: provider.id,
    runtime_alias: provider.executable,
    task_ref: taskRef,
    request_key: requestKey,
    bootstrap_argv: [provider.executable, ...bootstrap.argv],
    observation_kind: bootstrap.observation_kind,
    terminal_attestation: structuredClone(bootstrap.terminal_attestation),
  };
  const bootstrapIdentity = `computer-interface-bootstrap:${Buffer.from(JSON.stringify([
    provider.id,
    taskRef,
    requestKey,
  ]), 'utf8').toString('base64url')}`;
  return {
    kind: 'computer-interface.authenticated-surface-bootstrap',
    version: 1,
    bootstrap_identity: bootstrapIdentity,
    provider_id: provider.id,
    runtime_alias: provider.executable,
    task_ref: taskRef,
    observation_kind: bootstrap.observation_kind,
    terminal_attestation: structuredClone(bootstrap.terminal_attestation),
    operation: 'start_session',
    descriptor: {
      process: {
        argv: intent.bootstrap_argv,
        cwd: '.',
        timeout_ms: bootstrap.run_timeout_ms,
        termination_grace_ms: 1000,
        expected_termination: null,
        env: {},
        inputs: [],
        input_trees: [],
        outputs: [],
        network_access: 'allowed',
        // The bootstrap says for itself whether its program creates children,
        // for the reason written beside `declaredContainment` in
        // prepare-computer-interface-session.mjs. No default: an option that
        // does not say is a setup mistake.
        containment: bootstrapContainment(bootstrap, provider),
        capture_fds: [1, 2],
        collected_files: [],
      },
      workspace_bindings: {environment: [], arguments: []},
      session_settings: {},
    },
    idempotency_key: bootstrapIdentity,
  };
}

/** Build a proof only when runtime-owned surface observation and the provider's
 * authoritative terminal record agree on the exact fresh session. */
export function verifyProviderTerminalSurface({bootstrap, process_session, terminal_record, runtime_observation_record, now_ms = Date.now()}) {
  assertExactObject(bootstrap, [
    'kind', 'version', 'bootstrap_identity', 'provider_id', 'runtime_alias', 'task_ref',
    'observation_kind', 'terminal_attestation', 'operation', 'descriptor', 'idempotency_key',
  ], 'invalid_bootstrap');
  if (bootstrap.kind !== 'computer-interface.authenticated-surface-bootstrap' || bootstrap.version !== 1) {
    throw failure('invalid_bootstrap', 'The separate browsing screen request is invalid.');
  }
  if (!BOOTSTRAP_ID.test(bootstrap.bootstrap_identity ?? '')) {
    throw failure('invalid_bootstrap', 'The separate browsing screen request is invalid.');
  }
  validateTerminalAttestation(bootstrap.terminal_attestation);
  if (!Number.isSafeInteger(now_ms)) throw failure('invalid_current_time', 'The current time could not be verified.');
  assertPlainObject(process_session, 'invalid_process_session');
  const sessionId = nonEmpty(process_session.session_id, 'invalid_process_session');
  assertPlainObject(process_session.snapshot, 'invalid_process_session');
  if (process_session.snapshot.session_id !== sessionId) {
    throw failure('process_session_mismatch', 'The browsing process does not match this separate screen request.');
  }
  const currentBinding = selectCurrentSurfaceBinding(bootstrap, process_session);
  const terminalAddress = nonEmpty(process_session.snapshot.terminal_output_address, 'surface_not_ready');
  assertExactObject(terminal_record, ['address', 'content_hash', 'bytes'], 'invalid_surface_observation');
  if (terminal_record.address !== terminalAddress || !CONTENT_HASH.test(terminal_record.content_hash ?? '')) {
    throw failure('terminal_record_mismatch', 'The browsing screen check came from a different process.');
  }
  const bytes = toBytes(terminal_record.bytes);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OBSERVATION_BYTES) {
    throw failure('invalid_surface_observation', 'The separate browsing screen check is invalid.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw failure('invalid_surface_observation', 'The separate browsing screen check is invalid.');
  }
  for (const source of bootstrap.terminal_attestation.forbidden_patterns) {
    if (new RegExp(source, 'u').test(text)) {
      throw failure('surface_activity_detected', 'The separate browsing screen was not blank.');
    }
  }
  const matches = [...text.matchAll(new RegExp(bootstrap.terminal_attestation.session_id_pattern, 'gu'))];
  if (matches.length !== 1 || typeof matches[0][1] !== 'string' || matches[0][1].length > 256) {
    throw failure('invalid_surface_observation', 'The browsing option did not identify the new separate screen.');
  }
  const providerSessionId = matches[0][1];
  const observationAddress = currentBinding.observation_ref;
  const observationHash = currentBinding.observation_hash;
  assertExactObject(runtime_observation_record, ['address', 'content_hash', 'bytes'], 'invalid_runtime_surface_observation');
  if (runtime_observation_record.address !== observationAddress
    || runtime_observation_record.content_hash !== observationHash
    || !CONTENT_HASH.test(runtime_observation_record.content_hash ?? '')) {
    throw failure('runtime_surface_observation_mismatch', 'The separate browsing screen check is not current.');
  }
  const observationBytes = toBytes(runtime_observation_record.bytes);
  if (observationBytes.byteLength === 0 || observationBytes.byteLength > MAX_OBSERVATION_BYTES) {
    throw failure('invalid_runtime_surface_observation', 'The separate browsing screen check is invalid.');
  }
  let runtimeObservation;
  try {
    runtimeObservation = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(observationBytes));
  } catch {
    throw failure('invalid_runtime_surface_observation', 'The separate browsing screen check is invalid.');
  }
  validateRuntimeSurfaceObservation(runtimeObservation, {
    bootstrap,
    sessionId,
    providerSessionId,
    nowMs: now_ms,
  });
  if (runtimeObservation.lifecycle_revision !== currentBinding.lifecycle_revision
    || runtimeObservation.valid_until_ms !== currentBinding.valid_until_ms) {
    throw failure('runtime_surface_observation_mismatch', 'The separate browsing screen check is not current.');
  }
  return {
    kind: PROOF_KIND,
    version: 1,
    bootstrap_identity: bootstrap.bootstrap_identity,
    provider_id: bootstrap.provider_id,
    runtime_alias: bootstrap.runtime_alias,
    process_session_id: sessionId,
    provider_session_id: providerSessionId,
    task_ref: bootstrap.task_ref,
    lifecycle_revision: runtimeObservation.lifecycle_revision,
    valid_until_ms: runtimeObservation.valid_until_ms,
    surface_identity: runtimeObservation.surface_identity,
    page_identity: runtimeObservation.page_identity,
    isolation_scope: 'task',
    independent_pointer: true,
    independent_keyboard: true,
    pointer_identity: runtimeObservation.pointer_identity,
    keyboard_identity: runtimeObservation.keyboard_identity,
    input_focus_identity: runtimeObservation.input_focus_identity,
    visible_on_personal_display: false,
    observation_ref: observationAddress,
    observation_hash: observationHash,
    terminal_output_ref: terminalAddress,
    terminal_output_hash: terminal_record.content_hash,
  };
}

export function selectCurrentSurfaceBinding(bootstrap, processSession) {
  assertPlainObject(processSession, 'invalid_process_session');
  if (processSession.result !== 'session_read') {
    throw failure('surface_not_current', 'The separate browsing screen is not current for this task.');
  }
  const sessionId = nonEmpty(processSession.session_id, 'invalid_process_session');
  assertPlainObject(processSession.snapshot, 'invalid_process_session');
  if (processSession.snapshot.session_id !== sessionId
    || processSession.snapshot.state !== 'running') {
    throw failure('surface_not_current', 'The separate browsing screen is no longer running.');
  }
  const bindings = processSession.snapshot.surface_isolation_observations;
  if (!Array.isArray(bindings) || bindings.length > 16) {
    throw failure('invalid_runtime_surface_observation', 'The separate browsing screen check is invalid.');
  }
  const matches = bindings.filter((binding) => (
    binding?.bootstrap_identity === bootstrap.bootstrap_identity
    && binding?.task_ref === bootstrap.task_ref
  ));
  if (matches.length !== 1) {
    throw failure('surface_not_current', 'The separate browsing screen is not current for this task.');
  }
  const binding = matches[0];
  assertExactObject(binding, [
    'bootstrap_identity', 'task_ref', 'provider_session_id', 'lifecycle_revision',
    'observation_ref', 'observation_hash', 'valid_until_ms',
  ], 'invalid_runtime_surface_observation');
  for (const key of [
    'provider_session_id', 'lifecycle_revision', 'observation_ref', 'observation_hash',
  ]) nonEmpty(binding[key], 'invalid_runtime_surface_observation');
  if (!CONTENT_HASH.test(binding.observation_hash)
    || !Number.isSafeInteger(binding.valid_until_ms)) {
    throw failure('invalid_runtime_surface_observation', 'The separate browsing screen check is invalid.');
  }
  return structuredClone(binding);
}

export function selectCurrentSurfaceState(savedState, currentProcessSession) {
  assertExactObject(savedState, ['kind', 'bootstrap', 'process_session'], 'invalid_bootstrap_state');
  if (savedState.kind !== 'computer-interface.authenticated-surface-bootstrap-state') {
    throw failure('invalid_bootstrap_state', 'The separate browsing screen request is invalid.');
  }
  if (savedState.process_session?.session_id !== currentProcessSession?.session_id) {
    throw failure('process_session_mismatch', 'The browsing process does not match this separate screen request.');
  }
  const currentBinding = selectCurrentSurfaceBinding(savedState.bootstrap, currentProcessSession);
  return {
    kind: savedState.kind,
    bootstrap: structuredClone(savedState.bootstrap),
    process_session: structuredClone(currentProcessSession),
    current_binding: currentBinding,
  };
}

export function asAuthenticatedSurfaceRefusal(error) {
  return {
    ok: false,
    code: error instanceof AuthenticatedSurfaceBootstrapError ? error.code : 'unexpected_error',
    message: error instanceof Error ? error.message : 'The separate browsing screen could not be prepared.',
  };
}

function findProvider(providerId, providersDoc) {
  assertPlainObject(providersDoc, 'invalid_provider_table');
  if (!Array.isArray(providersDoc.providers)) throw failure('invalid_provider_table', 'Browsing options are unavailable.');
  const matches = providersDoc.providers.filter((row) => row?.id === providerId);
  if (matches.length !== 1) throw failure(matches.length ? 'ambiguous_provider' : 'unknown_provider', 'The browsing option is not available.');
  return matches[0];
}

function assertExactObject(value, keys, code) {
  assertPlainObject(value, code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw failure(code, 'The separate browsing screen request is invalid.');
  }
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure(code, 'The separate browsing screen request is invalid.');
  }
}

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw failure(code, 'The separate browsing screen request is invalid.');
  }
  return value;
}

function portableArgument(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function validateTerminalAttestation(value) {
  assertExactObject(value, ['session_id_pattern', 'forbidden_patterns'], 'invalid_bootstrap_data');
  nonEmpty(value.session_id_pattern, 'invalid_bootstrap_data');
  if (!Array.isArray(value.forbidden_patterns) || value.forbidden_patterns.length > 16) {
    throw failure('invalid_bootstrap_data', 'The separate browsing screen setup is incomplete.');
  }
  for (const source of value.forbidden_patterns) {
    if (typeof source !== 'string' || source.length === 0 || source.length > 512) {
      throw failure('invalid_bootstrap_data', 'The separate browsing screen setup is incomplete.');
    }
    try { new RegExp(source, 'u'); } catch { throw failure('invalid_bootstrap_data', 'The separate browsing screen setup is incomplete.'); }
  }
}

function validateRuntimeSurfaceObservation(value, {bootstrap, sessionId, providerSessionId, nowMs}) {
  assertExactObject(value, [
    'kind', 'version', 'bootstrap_identity', 'task_ref', 'provider_id', 'runtime_alias',
    'process_session_id', 'provider_session_id', 'lifecycle_state', 'lifecycle_revision',
    'revoked', 'observed_at_ms', 'valid_until_ms', 'surface_identity', 'page_identity',
    'pointer_identity', 'keyboard_identity', 'input_focus_identity',
    'independent_pointer', 'independent_keyboard', 'visible_on_personal_display',
  ], 'invalid_runtime_surface_observation');
  const expected = {
    kind: 'process-session.task-surface-isolation-observation',
    version: 1,
    bootstrap_identity: bootstrap.bootstrap_identity,
    task_ref: bootstrap.task_ref,
    provider_id: bootstrap.provider_id,
    runtime_alias: bootstrap.runtime_alias,
    process_session_id: sessionId,
    provider_session_id: providerSessionId,
    lifecycle_state: 'active',
    revoked: false,
    independent_pointer: true,
    independent_keyboard: true,
    visible_on_personal_display: false,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      throw failure('runtime_surface_mismatch', 'The separate browsing screen is not current for this task.');
    }
  }
  for (const key of ['lifecycle_revision', 'surface_identity', 'page_identity', 'pointer_identity', 'keyboard_identity', 'input_focus_identity']) {
    nonEmpty(value[key], 'invalid_runtime_surface_observation');
  }
  if (!Number.isSafeInteger(value.observed_at_ms)
    || !Number.isSafeInteger(value.valid_until_ms)
    || value.observed_at_ms > nowMs
    || value.valid_until_ms < nowMs
    || value.valid_until_ms - value.observed_at_ms > 300000) {
    throw failure('runtime_surface_stale', 'The separate browsing screen check has expired.');
  }
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw failure('invalid_surface_observation', 'The separate browsing screen check is invalid.');
}

function failure(code, message) {
  return new AuthenticatedSurfaceBootstrapError(code, message);
}

function bootstrapContainment(bootstrap, provider) {
  const containment = bootstrap.containment;
  if (!containment || typeof containment !== 'object' || Array.isArray(containment)) {
    throw failure('containment_not_declared', `The browsing option "${provider.id}" has incomplete setup.`);
  }
  return containment;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2).replaceAll('-', '_'), all[index + 1]]);
    return pairs;
  }, []));
  if (!args.mode || !args.output) throw failure('missing_argument', 'Required browsing setup files are missing.');
  if (args.mode === 'prepare') {
    if (!args.input || !args.providers) throw failure('missing_argument', 'Required browsing setup files are missing.');
    const [request, providersDoc] = await Promise.all([
      readFile(args.input, 'utf8').then(JSON.parse),
      readFile(args.providers, 'utf8').then(JSON.parse),
    ]);
    await writeFile(args.output, JSON.stringify(prepareAuthenticatedSurfaceBootstrap(request, providersDoc)));
    return;
  }
  if (args.mode === 'select') {
    if (!args.state || !args.current_session) {
      throw failure('missing_argument', 'Required browsing setup files are missing.');
    }
    const [state, currentSession] = await Promise.all([
      readFile(args.state, 'utf8').then(JSON.parse),
      readFile(args.current_session, 'utf8').then(JSON.parse),
    ]);
    await writeFile(args.output, JSON.stringify(selectCurrentSurfaceState(state, currentSession)));
    return;
  }
  if (args.mode === 'verify') {
    if (!args.state || !args.terminal || !args.terminal_address || !args.terminal_hash
      || !args.surface_observation || !args.surface_observation_address || !args.surface_observation_hash) {
      throw failure('missing_argument', 'Required browsing setup files are missing.');
    }
    const [state, terminalBytes, runtimeObservationBytes] = await Promise.all([
      readFile(args.state, 'utf8').then(JSON.parse),
      readFile(args.terminal),
      readFile(args.surface_observation),
    ]);
    assertExactObject(state, ['kind', 'bootstrap', 'process_session', 'current_binding'], 'invalid_bootstrap_state');
    if (state.kind !== 'computer-interface.authenticated-surface-bootstrap-state') {
      throw failure('invalid_bootstrap_state', 'The separate browsing screen request is invalid.');
    }
    const proof = verifyProviderTerminalSurface({
      bootstrap: state.bootstrap,
      process_session: state.process_session,
      terminal_record: {address: args.terminal_address, content_hash: args.terminal_hash, bytes: terminalBytes},
      runtime_observation_record: {
        address: args.surface_observation_address,
        content_hash: args.surface_observation_hash,
        bytes: runtimeObservationBytes,
      },
      ...(args.now_ms ? {now_ms: Number(args.now_ms)} : {}),
    });
    if (proof.observation_ref !== state.current_binding.observation_ref
      || proof.observation_hash !== state.current_binding.observation_hash) {
      throw failure('runtime_surface_observation_mismatch', 'The separate browsing screen check is not current.');
    }
    await writeFile(args.output, JSON.stringify(proof));
    return;
  }
  throw failure('unknown_mode', 'The separate browsing screen request is invalid.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify(asAuthenticatedSurfaceRefusal(error)) + '\n');
    process.exit(1);
  });
}
