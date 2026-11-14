#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/capture-native-readback.mjs
//
// Generic native model-visible readback owner. The runtime command, exact version
// matcher, expected input closure/hash, and failure action are DATA in the request.
// A caller supplies the native runtime boundary (normally an adapter/wire owner);
// tests inject it. Missing or mismatched evidence returns READBACK_UNAVAILABLE and
// denies activation/effect locally before the guarded work-control launch.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The built JS owner rather than the runtime-kit re-export, which ships as raw TypeScript inside
// node_modules and cannot be loaded from a plain `.mjs` under `node --test`. Same authority.
// See the longer note in `dispatch-harness-session.mjs`.
import { makeHashCodeHexFromBytes, makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';

import { emitSessionEvent } from './emit-session-event.mjs';

export const NATIVE_READBACK_REQUEST_SCHEMA = 'ai-cli-launch-adapters.native-readback-capture-request';
export const NATIVE_READBACK_RECEIPT_SCHEMA = 'ai-cli-launch-adapters.native-readback-receipt';
export const NATIVE_READBACK_OBSERVATION_SCHEMA = 'ai-cli-launch-adapters.native-readback-observation';
export const READBACK_UNAVAILABLE = 'READBACK_UNAVAILABLE';
export const NATIVE_READBACK_PROVEN = 'NATIVE_READBACK_PROVEN';

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function exactArray(value) {
  return Array.isArray(value) ? value : null;
}

// ⛔ THIS DEMANDED BARE 64-HEX, WHICH IS A VALUE THAT DOES NOT SAY WHAT PRODUCED IT.
// `[0-9a-f]{64}` accepts a SHA-256 digest, a BLAKE3 digest, a SHA3-256 digest and 64 random hex
// characters with exactly equal enthusiasm. It checks the SHAPE of a value and says nothing about
// its MEANING, so it could never have noticed the algorithm changing underneath it, which is the
// entire job of a check standing between a producer and a consumer of an identity.
//
// The producer, `finalInputIdentityDigest` in `dispatch-harness-session.mjs`, now emits the
// owner's `code:hex`; validation delegates to the shared Rust parser through WASM.
function validHash(value) {
  const text = nonEmpty(value);
  if (!text) return false;
  try { makeMultihashEncodedBytesFromCodeHex(text); return true; }
  catch { return false; }
}

function normalizedClosure(value) {
  if (!exactArray(value)) return null;
  const rows = value.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const mountPath = nonEmpty(entry.mount_path);
    const sourceHash = nonEmpty(entry.source_hash);
    if (!mountPath || !sourceHash) return null;
    return {
      mount_path: mountPath,
      content_type: nonEmpty(entry.content_type),
      executable: entry.executable === true,
      source_kind: nonEmpty(entry.source_kind),
      source_hash: sourceHash,
    };
  });
  if (rows.some((row) => row === null)) return null;
  const identity = rows.map((row) => row.mount_path);
  if (new Set(identity).size !== identity.length) return null;
  return rows;
}

const encoder = new TextEncoder();

// Two jobs wear this one name, and both are internal: minting `request_content_hash`, and
// comparing two structures for equality. Neither is defined by an outside party, so both route
// through the owner and the value declares its own algorithm.
function stableIdentity(value) {
  return makeHashCodeHexFromBytes(encoder.encode(JSON.stringify(value)));
}

function requestIdentity(request) {
  return stableIdentity({
    schema: request.schema,
    runtime_id: request.runtime_id,
    runtime_version_matcher: request.runtime_version_matcher,
    capture: request.capture,
    expected: request.expected,
    failure_action: request.failure_action,
  });
}

export function validateNativeReadbackRequest(value) {
  if (!value || typeof value !== 'object') throw new Error('native readback request must be an object');
  if (value.schema !== NATIVE_READBACK_REQUEST_SCHEMA) throw new Error(`native readback request schema must be ${NATIVE_READBACK_REQUEST_SCHEMA}`);

  const runtimeId = nonEmpty(value.runtime_id);
  if (!runtimeId) throw new Error('native readback request runtime_id is required');

  const matcher = value.runtime_version_matcher;
  if (!matcher || typeof matcher !== 'object' || matcher.kind !== 'exact' || !nonEmpty(matcher.value)) {
    throw new Error('native readback request requires exact runtime_version_matcher DATA');
  }

  const capture = value.capture;
  if (!capture || typeof capture !== 'object' || capture.kind !== 'command' || !exactArray(capture.argv)) {
    throw new Error('native readback request requires command capture DATA');
  }
  if (capture.argv.length === 0 || capture.argv.some((part) => !nonEmpty(part))) {
    throw new Error('native readback command argv must contain non-empty strings');
  }
  const timeout = Number(capture.timeout_ms);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('native readback command timeout_ms must be a positive integer');
  if (capture.stdout_format !== 'json') throw new Error('native readback command stdout_format must be json');

  const expected = value.expected;
  if (!expected || typeof expected !== 'object') throw new Error('native readback expected identity is required');
  const modelId = nonEmpty(expected.model_id);
  if (!modelId) throw new Error('native readback expected.model_id is required');
  const inputClosure = normalizedClosure(expected.input_closure);
  if (!inputClosure || inputClosure.length === 0) throw new Error('native readback expected.input_closure must be a non-empty unique mount set');
  const finalInputIdentityDigest = expected.final_input_identity_digest;
  if (!validHash(finalInputIdentityDigest)) throw new Error('native readback expected.final_input_identity_digest must be a multihash');

  const failureAction = value.failure_action;
  if (!failureAction || typeof failureAction !== 'object'
    || failureAction.activation !== 'deny'
    || failureAction.effect !== 'deny'
    || failureAction.receipt_status !== READBACK_UNAVAILABLE) {
    throw new Error('native readback failure_action must deny activation and effect');
  }

  return {
    schema: NATIVE_READBACK_REQUEST_SCHEMA,
    runtime_id: runtimeId,
    runtime_version_matcher: { kind: 'exact', value: matcher.value },
    capture: {
      kind: 'command',
      argv: [...capture.argv],
      timeout_ms: timeout,
      stdout_format: 'json',
    },
    expected: {
      model_id: modelId,
      input_closure: inputClosure,
      final_input_identity_digest: finalInputIdentityDigest,
    },
    failure_action: { activation: 'deny', effect: 'deny', receipt_status: READBACK_UNAVAILABLE },
  };
}

function planIdentity(plan) {
  const provenance = plan?.launch_provenance;
  if (!provenance || typeof provenance !== 'object') throw new Error('native readback requires a harness dispatch plan with launch_provenance');
  const model = nonEmpty(provenance.selected_model);
  const digest = provenance.final_input_identity_digest;
  if (!model) throw new Error('native readback plan has no selected_model');
  if (!validHash(digest)) throw new Error('native readback plan has no valid final_input_identity_digest');
  const closure = normalizedClosure(provenance.mounted_input_identities);
  if (!closure) throw new Error('native readback plan has no exact mounted_input_identities');
  return { model_id: model, input_closure: closure, final_input_identity_digest: digest };
}

function unavailableReceipt({ request, plan, reason, observed = null, now }) {
  const expected = planIdentity(plan);
  return {
    kind: 'native-readback-receipt',
    schema: NATIVE_READBACK_RECEIPT_SCHEMA,
    status: READBACK_UNAVAILABLE,
    reason,
    request_content_hash: requestIdentity(request),
    runtime_id: request.runtime_id,
    dispatch_key: nonEmpty(plan.dispatch_key),
    expected,
    observed,
    checks: {
      runtime_identity: false,
      runtime_version: false,
      model_visible_input: false,
      expected_hash: false,
    },
    activation_allowed: false,
    effect_allowed: false,
    launch_denied: true,
    event_evidence: 'audit-only; buffered emission is not readback or delivery proof',
    captured_at: nonEmpty(now) ?? new Date().toISOString(),
  };
}

export function buildNativeReadbackReceipt({ request: rawRequest, plan, readback: rawReadback, now } = {}) {
  const request = validateNativeReadbackRequest(rawRequest);
  const expected = planIdentity(plan);
  if (expected.model_id !== request.expected.model_id) {
    return unavailableReceipt({ request, plan, reason: 'request expected model does not match dispatch plan', now });
  }
  if (stableIdentity(expected.input_closure) !== stableIdentity(request.expected.input_closure)) {
    return unavailableReceipt({ request, plan, reason: 'request expected input closure does not match dispatch plan', now });
  }
  if (expected.final_input_identity_digest !== request.expected.final_input_identity_digest) {
    return unavailableReceipt({ request, plan, reason: 'request expected final input hash does not match dispatch plan', now });
  }
  if (!rawReadback || typeof rawReadback !== 'object') {
    return unavailableReceipt({ request, plan, reason: 'native readback observation is missing', now });
  }
  if (rawReadback.schema !== NATIVE_READBACK_OBSERVATION_SCHEMA) {
    return unavailableReceipt({ request, plan, reason: 'native readback observation schema is unknown', observed: null, now });
  }

  const runtimeMatch = rawReadback.runtime_id === request.runtime_id;
  const versionMatch = rawReadback.runtime_version === request.runtime_version_matcher.value;
  const modelMatch = rawReadback.model_id === expected.model_id;
  const observedClosure = normalizedClosure(rawReadback.input_closure);
  const closureMatch = observedClosure !== null
    && stableIdentity(observedClosure) === stableIdentity(expected.input_closure);
  const hashMatch = rawReadback.final_input_identity_digest === expected.final_input_identity_digest;
  const observed = {
    schema: NATIVE_READBACK_OBSERVATION_SCHEMA,
    runtime_id: nonEmpty(rawReadback.runtime_id),
    runtime_version: nonEmpty(rawReadback.runtime_version),
    model_id: nonEmpty(rawReadback.model_id),
    input_closure: observedClosure,
    final_input_identity_digest: validHash(rawReadback.final_input_identity_digest) ? rawReadback.final_input_identity_digest : null,
    captured_at: nonEmpty(rawReadback.captured_at),
  };

  const passed = runtimeMatch && versionMatch && modelMatch && closureMatch && hashMatch;
  if (!passed) {
    const first = !runtimeMatch ? 'runtime identity'
      : !versionMatch ? 'runtime version'
      : !modelMatch ? 'model identity'
      : !closureMatch ? 'model-visible input closure'
      : 'final input hash';
    return unavailableReceipt({
      request,
      plan,
      reason: `native readback ${first} does not match expected DATA`,
      observed,
      now,
    });
  }

  return {
    kind: 'native-readback-receipt',
    schema: NATIVE_READBACK_RECEIPT_SCHEMA,
    status: NATIVE_READBACK_PROVEN,
    reason: 'exact runtime, version, model-visible input closure, and final input hash readback matched',
    request_content_hash: requestIdentity(request),
    runtime_id: request.runtime_id,
    dispatch_key: nonEmpty(plan.dispatch_key),
    expected,
    observed,
    checks: {
      runtime_identity: true,
      runtime_version: true,
      model_visible_input: true,
      expected_hash: true,
    },
    activation_allowed: true,
    effect_allowed: true,
    launch_denied: false,
    event_evidence: 'no blocked event required',
    captured_at: nonEmpty(now) ?? new Date().toISOString(),
  };
}

export async function captureNativeReadback(options = {}) {
  let request;
  try {
    request = validateNativeReadbackRequest(options.request);
  } catch (error) {
    return {
      kind: 'native-readback-receipt',
      schema: NATIVE_READBACK_RECEIPT_SCHEMA,
      status: READBACK_UNAVAILABLE,
      reason: error.message,
      activation_allowed: false,
      effect_allowed: false,
      launch_denied: true,
      event_evidence: 'audit-only; buffered emission is not readback or delivery proof',
    };
  }

  let readback = null;
  if (typeof options.captureRuntime === 'function') {
    try {
      readback = await options.captureRuntime({ request, plan: options.plan });
    } catch (error) {
      readback = { capture_error: error?.message ?? String(error) };
    }
  }

  const receipt = buildNativeReadbackReceipt({
    request,
    plan: options.plan,
    readback,
    now: options.now,
  });
  if (receipt.status === READBACK_UNAVAILABLE && options.emitEvent !== null) {
    const emit = options.emitEvent ?? emitSessionEvent;
    await emit({
      event_kind: 'readback-blocked',
      session_id: nonEmpty(options.sessionId) ?? nonEmpty(options.plan?.session_ref) ?? 'native-readback',
      seq: options.eventSeq,
      provider_ref: nonEmpty(options.plan?.launch_provenance?.selected_model) ?? request.runtime_id,
      tool_name: 'ai-cli-launch-adapters.capture-native-readback',
      contract_ref: nonEmpty(options.contractRef),
    }, {
      env: options.env,
      fetchImpl: options.fetchImpl,
      target: options.eventTarget,
      io: options.eventIo,
      log: options.log ?? (() => {}),
    });
  }
  return receipt;
}

export async function main(argv = process.argv) {
  const readArg = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  const requestFile = readArg('request-file');
  const planFile = readArg('plan-file');
  if (!requestFile || !planFile) {
    process.stdout.write(JSON.stringify({
      kind: 'native-readback-receipt',
      schema: NATIVE_READBACK_RECEIPT_SCHEMA,
      status: READBACK_UNAVAILABLE,
      reason: 'request-file and plan-file are required',
      activation_allowed: false,
      effect_allowed: false,
      launch_denied: true,
    }));
    return;
  }
  const receipt = await captureNativeReadback({
    request: JSON.parse(readFileSync(requestFile, 'utf8')),
    plan: JSON.parse(readFileSync(planFile, 'utf8')),
  });
  process.stdout.write(JSON.stringify(receipt));
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (IS_MAIN) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({
      kind: 'native-readback-receipt',
      schema: NATIVE_READBACK_RECEIPT_SCHEMA,
      status: READBACK_UNAVAILABLE,
      reason: error?.message ?? String(error),
      activation_allowed: false,
      effect_allowed: false,
      launch_denied: true,
    }));
  }).finally(() => process.exit(0));
}
