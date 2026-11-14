import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SAFE = 'package::ai-agent-profile::agent::autonomous-safe-operator';
const ROUTED = 'package::ai-agent-profile::agent::owner-routed-operator';
const TOOL = 'package::ai-tool-catalog::tool::start-assigned-work-session';

function payload(read) {
  if (read?.found !== true) return null;
  if (read.payload && typeof read.payload === 'object') return read.payload;
  if (typeof read.payload_base64 === 'string') {
    return JSON.parse(Buffer.from(read.payload_base64, 'base64').toString('utf8'));
  }
  throw new Error('current record has no readable payload');
}

function expectedCurrent(read) {
  if (read?.found !== true) return { payload_hash_base64: null };
  const match = /^([0-9a-f]+):([0-9a-f]+)$/.exec(read.content_hash ?? '');
  if (!match || match[2].length % 2) throw new Error('current record has no valid content hash');
  const varint = (value) => {
    const bytes = [];
    for (let n = BigInt(value); n >= 0n;) {
      const byte = Number(n & 0x7fn);
      n >>= 7n;
      bytes.push(n ? byte | 0x80 : byte);
      if (!n) break;
    }
    return bytes;
  };
  const digest = Buffer.from(match[2], 'hex');
  return { payload_hash_base64: Buffer.from([
    ...varint(BigInt('0x' + match[1])), ...varint(digest.length), ...digest,
  ]).toString('base64') };
}

const absent = { payload_hash_base64: null };
const no = (status) => ({ status, writes: [], start: null });

/** A plan only. The caller must atomically write every entry before starting work. */
export function planSourceMessageReopen({
  findingRef, findingRead, bindingRead, observedSourceRead, requestRead, taskStatusRead,
  generationRead, previousFindingRead, at,
}) {
  if (payload(previousFindingRead)) return no('already-reopened');
  const finding = payload(findingRead);
  const binding = payload(bindingRead);
  const observed = payload(observedSourceRead);
  if (!finding || finding.kind !== 'request-intake.outcome-verification'
    || finding.finding_ref !== findingRef || finding.result !== 'failed'
    || !finding.source_event_ref || !finding.binding_ref
    || !binding || binding.kind !== 'request-intake.outcome-binding'
    || binding.binding_ref !== finding.binding_ref
    || !binding.outcome_ref || !binding.authorized_producer_ref
    || !observed || observed.event_ref !== finding.source_event_ref
    || observed.binding_ref !== binding.binding_ref
    || observed.outcome_ref !== binding.outcome_ref
    || observed.producer_ref !== binding.authorized_producer_ref
    || observed.result !== 'failed') return no('unverified-finding');

  const taskRef = binding.task_ref;
  const request = payload(requestRead);
  if (typeof taskRef !== 'string' || !taskRef.startsWith('request:')
    || request?.kind !== 'request-intake.source-message-decision'
    || request.record_ref !== binding.request_ref || request.task_ref !== taskRef
    || binding.request_ref !== taskRef
    || typeof request.text !== 'string'
    || !['private-local', 'owner-routed'].includes(request.effect_class)) {
    return no('request-mismatch');
  }
  const status = payload(taskStatusRead);
  if (status?.subject_id !== taskRef || status.property_id !== 'prop:task:status') {
    return no('task-missing');
  }
  if (status.value_json !== 'completed') return no('task-not-completed');
  const generation = payload(generationRead);
  const current = generation === null ? 0 : generation.generation;
  if (!Number.isSafeInteger(current) || current < 0
    || (generation && generation.task_ref !== taskRef)
    || binding.generation !== current) return no('stale-generation');
  if (typeof at !== 'string' || !at) throw new Error('observation time is required');

  const next = current + 1;
  const attempt = taskRef + ':execution-attempt:' + next;
  const sourceRef = attempt + ':assigned-work-source';
  const claimRef = attempt + ':claim';
  const safe = request.effect_class === 'private-local';
  const worker = safe ? SAFE : ROUTED;
  const workerId = safe
    ? 'ai-agent-profile:autonomous-safe-operator'
    : 'ai-agent-profile:owner-routed-operator';
  const record = (address_label, address_mode, path_labels, value, expected_current = absent) =>
    ({ address_label, address_mode, path_labels, payload: value, expected_current });
  const published = ['current-item', 'published-record'];
  const writes = [
    record('attribute_fact|' + taskRef + '|prop:task:status|type:string',
      'label_hash', [], { ...status, value_json: 'pending' }, expectedCurrent(taskStatusRead)),
    record(taskRef + ':execution-generation', 'identity_text', published,
      { kind: 'request-intake.execution-generation', task_ref: taskRef,
        generation: next, finding_ref: findingRef }, expectedCurrent(generationRead)),
    record(findingRef + ':reopen', 'identity_text', published,
      { kind: 'request-intake.reopened-finding', finding_ref: findingRef,
        task_ref: taskRef, generation: next, observed_at: at }),
    record(claimRef, 'identity_text', published,
      { kind: 'request-intake.task-execution-claim', claim_ref: claimRef,
        task_ref: taskRef, source_ref: request.source_ref, generation: next,
        status: 'pending-start', claimed_at: at, owner_ref: workerId,
        work_source_ref: sourceRef }),
    record(sourceRef, 'identity_text', published,
      { kind: 'assigned-work-source', owner: 'request-intake',
        task_ref: taskRef, generation: next, title: request.text.slice(0, 240),
        objective: request.text + '\n\nCorrect the failed check at ' + findingRef +
          ', then verify the original outcome.',
        acceptance_criteria: ['The failed check passes and the original outcome is verified.'],
        assignedTo: [workerId], estimated_cost: 0,
        effect_boundary: safe ? 'Reversible private local work only.' :
          'Use declared effect owners and verify exact targets, privacy, and real outcomes.',
        state: 'ready' }),
  ];
  return { status: 'reopen', writes, start: {
    sourceRecordRef: sourceRef, workerRecordRef: worker,
    workerRecordAddressMode: 'label_hash', toolRecordRef: TOOL,
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const names = [
    'findingRead', 'bindingRead', 'observedSourceRead', 'requestRead', 'taskStatusRead',
    'generationRead', 'previousFindingRead',
  ];
  const [findingRef, at, ...paths] = process.argv.slice(2);
  if (!findingRef || !at || paths.length !== names.length + 1) {
    throw new Error('expected finding ref, observed time, seven owner reads, and output path');
  }
  const input = { findingRef, at };
  for (let i = 0; i < names.length; i += 1) {
    input[names[i]] = JSON.parse(readFileSync(paths[i], 'utf8'));
  }
  writeFileSync(paths.at(-1), JSON.stringify(planSourceMessageReopen(input)));
}
