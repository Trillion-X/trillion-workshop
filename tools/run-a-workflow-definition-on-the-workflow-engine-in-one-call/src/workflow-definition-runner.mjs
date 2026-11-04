// src/workflow-definition-runner.mjs
//
// Purpose: the workflow engine (crates/workflow-core, run through crates/workflow-engine) as one call: a definition,
// its input and the answers known so far go in, and the run comes out. It is the Workshop tool
// tool:run-workflow-definition (records/workshop-engine-tool-records.json), and a person's workflows
// (src/workflows.mjs) reach the engine only through that tool.
//
// Bounded continuation: the separate v1 method uses explicit host-owned limits and refuses when the pinned module
// lacks `run_bounded_v1`. It retains the same hostless answer and waiting behavior.
//
// Non-Negotiable Invariants:
//   1. The engine runs the definition from the start on every call; an ask it has an answer for goes on, and an ask
//      without one pauses the run there (workflow-core's `not-answered-yet`), so calling again with more answers goes
//      on from where it stopped.
//   2. Without a host (an AI calling run_tool), an ask is answered from `answers` by its step id (the ask's
//      `config.context.step_id`) or its name; the asks with no answer are returned as `waiting`, each with the input the
//      engine gave it, and a read is refused with the reason.
//   3. With a host (Trillion itself, in the same process), `host.ask(name, payload bytes, context bytes)` and
//      `host.read(from)` answer every ask and read as the engine makes them.
//   4. Nothing here names a step kind, a tool or an agent.
//   5. The engine's namespace word is this app's own declared name (package.json `name`), read here and passed in;
//      the engine derives its process wire identities from it.
//
import manifest from '../package.json' with { type: 'json' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const BOUNDED_WORKFLOW_API_VERSION = 'trillion.workflow-engine.run-bounded/v1';
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const valueOf = bytes => (bytes === undefined || bytes === null ? {} : JSON.parse(decoder.decode(bytes)));
const positiveWasmLimit = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;

const envelopeKeys = [
  'max_definitions_json_bytes', 'max_input_json_bytes', 'max_id_bytes', 'max_partition_bytes',
  'max_definitions', 'max_total_steps', 'max_total_edges', 'max_nested_closure_bytes',
  'max_output_json_bytes',
];
const executionKeys = ['max_step_attempts', 'max_loop_iterations', 'max_action_depth'];

function validateLimits(limits) {
  if (!object(limits) || !object(limits.envelope) || !object(limits.execution)) {
    throw new TypeError('FE_BOUNDED_POLICY_INVALID: pass explicit host-owned envelope and execution limits');
  }
  for (const key of envelopeKeys) {
    if (!positiveWasmLimit(limits.envelope[key])) throw new TypeError(`FE_BOUNDED_POLICY_INVALID: ${key} must be a positive u32`);
  }
  for (const key of executionKeys) {
    if (!positiveWasmLimit(limits.execution[key])) throw new TypeError(`FE_BOUNDED_POLICY_INVALID: ${key} must be a positive u32`);
  }
  // Copy the scalar policy now. The caller may mutate its objects while the
  // asynchronous engine loader is resolving.
  return {
    envelope: Object.freeze(Object.fromEntries(envelopeKeys.map(key => [key, limits.envelope[key]]))),
    execution: Object.freeze(Object.fromEntries(executionKeys.map(key => [key, limits.execution[key]]))),
  };
}

function boundedCallArguments(limits) {
  const e = limits.envelope;
  const x = limits.execution;
  return [
    e.max_definitions_json_bytes, e.max_input_json_bytes, e.max_id_bytes, e.max_partition_bytes,
    e.max_definitions, e.max_total_steps, e.max_total_edges, e.max_nested_closure_bytes,
    e.max_output_json_bytes, x.max_step_attempts, x.max_loop_iterations, x.max_action_depth,
  ];
}

function parseBoundedResponse(raw, limits, request) {
  if (typeof raw !== 'string') throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: engine response must be JSON text');
  if (encoder.encode(raw).byteLength > limits.envelope.max_output_json_bytes) {
    throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: raw response exceeds max_output_json_bytes');
  }
  let response;
  try { response = JSON.parse(raw); }
  catch { throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: engine returned malformed JSON'); }
  if (!object(response) || response.version !== BOUNDED_WORKFLOW_API_VERSION ||
      !object(response.usage) || !object(response.result) ||
      Object.keys(response).sort().join(',') !== 'result,usage,version') {
    throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: versioned response envelope is missing or has the wrong shape');
  }
  for (const key of ['step_attempts', 'loop_iterations', 'action_depth']) {
    if (!Number.isSafeInteger(response.usage[key]) || response.usage[key] < 0) {
      throw new TypeError(`FE_BOUNDED_RESPONSE_INVALID: usage.${key} is invalid`);
    }
  }
  if (Object.keys(response.usage).sort().join(',') !== 'action_depth,loop_iterations,step_attempts') {
    throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: usage object has an unexpected shape');
  }
  if (response.usage.step_attempts > limits.execution.max_step_attempts ||
      response.usage.loop_iterations > limits.execution.max_loop_iterations ||
      response.usage.action_depth > limits.execution.max_action_depth) {
    throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: engine usage exceeds the captured host limits');
  }
  if (!['completed', 'failed', 'paused'].includes(response.result.status)) {
    throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: result.status is invalid');
  }
  const resultKeys = [
    'completed_at', 'current_step', 'error_message', 'execution_context', 'id', 'partition_key',
    'start_id', 'started_at', 'status', 'workflow_id',
  ];
  if (Object.hasOwn(response.result, 'runtime_outputs')) resultKeys.push('runtime_outputs');
  if (Object.keys(response.result).sort().join(',') !== resultKeys.sort().join(',') ||
      (Object.hasOwn(response.result, 'runtime_outputs') && !object(response.result.runtime_outputs)) ||
      typeof response.result.id !== 'string' || typeof response.result.workflow_id !== 'string' ||
      typeof response.result.partition_key !== 'string' || !Number.isSafeInteger(response.result.current_step) ||
      response.result.current_step < 0 || response.result.current_step > 0x7fff_ffff ||
      response.result.workflow_id !== request.workflowId || response.result.partition_key !== request.partition ||
      !object(response.result.execution_context)) {
    throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: result instance has an unexpected shape or identity');
  }
  if (request.startedAt.length || request.startId !== null) {
    const start = response.result.execution_context.start;
    if (!object(start) || start.started_at !== request.startedAt || start.start_id !== request.startId ||
        response.result.start_id !== request.startId ||
        (request.startedAt.length && response.result.started_at !== request.startedAt)) {
      throw new TypeError('FE_BOUNDED_RESPONSE_INVALID: engine changed the supplied replay start');
    }
  }
  return response;
}

function parseBoundedFailure(reason) {
  if (typeof reason !== 'string') throw new Error('FE_BOUNDED_ENGINE_REFUSED: engine rejected bounded execution');
  if (encoder.encode(reason).byteLength > 512) {
    throw new Error('FE_BOUNDED_ENGINE_REFUSED: failure envelope exceeds 512 UTF-8 bytes');
  }
  let failure;
  try { failure = JSON.parse(reason); }
  catch { throw new Error('FE_BOUNDED_ENGINE_REFUSED: engine returned an invalid failure envelope'); }
  if (!object(failure) || failure.version !== BOUNDED_WORKFLOW_API_VERSION ||
      !object(failure.error) || typeof failure.error.code !== 'string') {
    throw new Error('FE_BOUNDED_ENGINE_REFUSED: engine returned an invalid failure envelope');
  }
  const error = new Error(failure.error.message ?? failure.error.detail ?? failure.error.code);
  error.code = failure.error.code;
  error.details = failure.error;
  throw error;
}

function answerIdentity(context, name) {
  const identity = context._runtime_identity;
  return Array.isArray(identity) && identity.length > 1 ? JSON.stringify(identity)
    : context.step_id ?? (Array.isArray(identity) ? identity.at(-1) : undefined) ?? name;
}

/** engine: () → the workflow engine's bindings ({ run }), or a promise of them. */
export function makeWorkflowDefinitionRunner(engine) {
  /**
   * input: { definitions: [definition], workflow_id, input?, answers?: { [step id or ask name]: answer }, partition? }
   * host:  { ask(name, payloadBytes, contextBytes) → Uint8Array, read(from) → Uint8Array } when Trillion calls in process
   */
  async function runWorkflowDefinition(input, host = null) {
    const answers = object(input?.answers) ? input.answers : {};
    const waiting = [];
    const ask = host?.ask ?? (async (name, payloadBytes, contextBytes) => {
      const context = valueOf(contextBytes);
      const step = answerIdentity(context, name);
      const known = Object.hasOwn(answers, step) ? answers[step] : Object.hasOwn(answers, name) ? answers[name] : undefined;
      if (known !== undefined) return encoder.encode(JSON.stringify(known));
      waiting.push({ step_id: step, asks: name, input: valueOf(payloadBytes) });
      return encoder.encode(JSON.stringify({ $kind: 'not-answered-yet', step_id: step }));
    });
    const read = host?.read ?? (async from => { throw new Error(`Nothing here answers a read of ${from}; give the value as an answer instead.`); });
    const definitions = Array.isArray(input?.definitions) ? input.definitions : [];
    const wasm = await engine();
    const args = [JSON.stringify(definitions), String(input?.workflow_id ?? ''), JSON.stringify(input?.input ?? {}), String(input?.partition ?? 'workflow'), manifest.name];
    const startedAt = input?.started_at;
    let encoded;
    if (typeof startedAt === 'string' && startedAt.length) {
      if (typeof wasm.runWithStartedAt !== 'function') throw new Error('The workflow engine does not support durable started_at replay yet.');
      encoded = await wasm.runWithStartedAt(...args, startedAt, ask, read);
    } else {
      encoded = await wasm.run(...args, ask, read);
    }
    const run = JSON.parse(encoded);
    return host ? run : { ...run, waiting };
  }
  /**
   * Bounded companion to runWorkflowDefinition. Limits must come from the host,
   * never workflow data. Missing v1 support is a refusal with no legacy fallback.
   */
  async function runWorkflowDefinitionBounded(input, host, suppliedLimits) {
    const limits = validateLimits(suppliedLimits);
    const definitionList = Array.isArray(input?.definitions) ? input.definitions : [];
    const request = {
      definitionsJson: JSON.stringify(definitionList),
      workflowId: String(input?.workflow_id ?? ''),
      inputJson: JSON.stringify(input?.input ?? {}),
      partition: String(input?.partition ?? 'workflow'),
      startedAt: input?.started_at ?? '',
      startId: input?.start_id ?? null,
    };
    if (typeof request.startedAt !== 'string' ||
        (request.startId !== null && typeof request.startId !== 'string')) {
      throw new TypeError('FE_BOUNDED_REQUEST_INVALID: started_at and start_id must be strings when supplied');
    }
    const hasStart = request.startedAt.length > 0 || request.startId !== null;
    const answers = object(input?.answers) ? input.answers : {};
    const answerJson = new Map();
    const answerKeys = new Set(Object.keys(answers));
    for (const key of Object.keys(answers)) {
      answerJson.set(key, JSON.stringify(answers[key]));
    }
    const hostAsk = host?.ask;
    const hostRead = host?.read;
    const waiting = [];
    const ask = hostAsk ?? (async (name, payloadBytes, contextBytes) => {
      const context = valueOf(contextBytes);
      const step = answerIdentity(context, name);
      const answerKey = answerKeys.has(step) ? step : answerKeys.has(name) ? name : undefined;
      const encoded = answerKey === undefined ? undefined : answerJson.get(answerKey);
      if (encoded !== undefined) return encoder.encode(encoded);
      waiting.push({ step_id: step, asks: name, input: valueOf(payloadBytes) });
      return encoder.encode(JSON.stringify({ $kind: 'not-answered-yet', step_id: step }));
    });
    const read = hostRead ?? (async from => { throw new Error(`Nothing here answers a read of ${from}; give the value as an answer instead.`); });
    const args = [
      request.definitionsJson, request.workflowId, request.inputJson, request.partition, manifest.name,
      ...boundedCallArguments(limits),
      ...(hasStart ? [request.startedAt, request.startId] : []), ask, read,
    ];
    const bindings = await engine();
    const exportName = hasStart ? 'run_bounded_with_start_v1' : 'run_bounded_v1';
    if (typeof bindings?.[exportName] !== 'function') {
      throw new Error(`FE_BOUNDED_ENGINE_UNSUPPORTED: ${exportName} is unavailable; upgrade the pinned engine module`);
    }
    let raw;
    try { raw = await bindings[exportName](...args); }
    catch (reason) { return parseBoundedFailure(reason); }
    const response = parseBoundedResponse(raw, limits, request);
    const finalResponse = host ? response : { ...response, result: { ...response.result, waiting } };
    if (encoder.encode(JSON.stringify(finalResponse)).length > limits.envelope.max_output_json_bytes) {
      throw new Error('FE_BOUNDED_RESPONSE_INVALID: final response exceeds max_output_json_bytes');
    }
    return finalResponse;
  }


  return { runWorkflowDefinition, runWorkflowDefinitionBounded };
}
