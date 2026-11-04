// Generic expression-owner request/reply composition. Evaluator semantics,
// operation selectors, field names, and transport targets are descriptor DATA.
// This protocol is work-layer physics; presentation imports it but never owns
// request composition, reply decoding, revision guards, or timeouts.

import type {
  ExpressionOwnerOperation,
  ExpressionReplySemanticKey,
  ExpressionRequestSemanticKey,
  VisualDatabaseExpressionAuthoringDescriptor,
  VisualDatabaseEvaluatorDescriptor,
} from '../read-data/visual-database';

const PATH_PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalExpressionOwnerJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function expressionEvaluationProvenanceLabels(
  evaluator: Pick<VisualDatabaseEvaluatorDescriptor, 'ref' | 'target' | 'label'>,
): {
  family: string;
  displayLabel: string;
} {
  const display = evaluator.label?.trim() || evaluator.ref;
  return {
    family: `expression-evaluation::owner=${encodeURIComponent(evaluator.ref)}::target=${encodeURIComponent(evaluator.target)}`,
    displayLabel: `${display} result`,
  };
}

export function expressionEvaluationProvenanceRef(input: {
  family: string;
  sourceRevision: string;
  evaluatorRevision: string;
}): string {
  return `${input.family}::source=${encodeURIComponent(input.sourceRevision)}::evaluator-revision=${encodeURIComponent(input.evaluatorRevision)}`;
}

/** Bounds every owner exchange with descriptor DATA. The transport may finish
 * later, but its result has no reducer path after this promise rejects. */
export async function withExpressionOwnerTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Expression owner timeout must be a positive integer.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The expression owner did not reply within ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalExpressionOwnerJson(left) === canonicalExpressionOwnerJson(right);
}

function assertPath(path: readonly string[]): void {
  if (path.length === 0 || path.length > 64 || path.some((segment) => (
    !segment || segment.trim() !== segment || PATH_PROTOTYPE_KEYS.has(segment)
  ))) throw new Error('Expression owner descriptor contains an invalid object path.');
}

function insertPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  assertPath(path);
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const existing = current[segment];
    if (existing === undefined) current[segment] = {};
    else if (!isRecord(existing)) {
      throw new Error(`Expression owner path cannot traverse ${JSON.stringify(path.slice(0, index + 1))}.`);
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1]!;
  if (hasOwn(current, leaf) && !jsonEqual(current[leaf], value)) {
    throw new Error(`Expression owner path ${JSON.stringify(path)} already contains a different value.`);
  }
  current[leaf] = cloneJsonValue(value);
}

function readPath(source: unknown, path: readonly string[]): { present: boolean; value?: unknown } {
  assertPath(path);
  let current = source;
  for (const segment of path) {
    if (!isRecord(current) || !hasOwn(current, segment)) return { present: false };
    current = current[segment];
  }
  return { present: true, value: current };
}

function deletePath(target: Record<string, unknown>, path: readonly string[]): void {
  assertPath(path);
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = current[segment];
    if (!isRecord(next)) return;
    parents.push({ parent: current, key: segment });
    current = next;
  }
  delete current[path[path.length - 1]!];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const { parent, key } = parents[index]!;
    if (isRecord(parent[key]) && Object.keys(parent[key] as Record<string, unknown>).length === 0) delete parent[key];
    else break;
  }
}

function deleteMatchingTemplate(
  target: Record<string, unknown>,
  template: Readonly<Record<string, unknown>>,
): void {
  for (const [key, templateValue] of Object.entries(template)) {
    if (!hasOwn(target, key)) continue;
    const targetValue = target[key];
    if (isRecord(templateValue) && isRecord(targetValue)) {
      deleteMatchingTemplate(targetValue, templateValue);
      if (Object.keys(targetValue).length === 0) delete target[key];
    } else if (jsonEqual(targetValue, templateValue)) {
      delete target[key];
    }
  }
}

function operationDescriptor(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  operation: ExpressionOwnerOperation,
) {
  return operation === 'project_source'
    ? descriptor.operations.projectSource
    : descriptor.operations[operation];
}

export type ExpressionOwnerRequestValues = Partial<
  Record<ExpressionRequestSemanticKey, unknown>
>;

/** Reads the exact authored source from durable owner request DATA. The source
 * field name/path belongs to the descriptor, not Visual Database. */
export function readDurableExpressionSource(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  request: unknown,
): string | null {
  const selected = readPath(request, descriptor.requestPaths.source);
  return selected.present && typeof selected.value === 'string' ? selected.value : null;
}

/** Produces canonical durable request DATA for one human source. Operation
 * template bytes and unrelated owner DATA survive; all transient authoring
 * inputs (caret, context, legacy payload, token, and revisions) are removed.
 * No target identity or owner field name is inspected. */
export function buildDurableExpressionOwnerRequest(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  source: string,
  existingRequest?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  // Operation templates are editor transport DATA, not durable evaluator
  // input. Persisting their token/revision operation discriminator would leave
  // a permanently incomplete query after those transient paths are removed.
  // A new source therefore starts as an empty owner request; an existing source
  // retains only unrelated owner-persistent members.
  const request = cloneJsonValue(existingRequest ?? {}) as Record<string, unknown>;
  for (const operation of [
    descriptor.operations.analyze,
    descriptor.operations.evaluate,
    descriptor.operations.capabilities,
    descriptor.operations.projectSource,
  ]) deleteMatchingTemplate(request, operation.requestTemplate);
  for (const key of Object.keys(descriptor.requestPaths) as ExpressionRequestSemanticKey[]) {
    deletePath(request, descriptor.requestPaths[key]);
  }
  insertPath(request, descriptor.requestPaths.source, source);
  return request;
}

/** Deep-clones the operation template and inserts only the operation's declared
 * semantic values. The descriptor decoder already proves paths are total and
 * independent; this function still fails closed if handed forged in-memory
 * DATA. */
export function composeExpressionOwnerRequest(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  operation: ExpressionOwnerOperation,
  values: ExpressionOwnerRequestValues,
): Record<string, unknown> {
  const operationData = operationDescriptor(descriptor, operation);
  const request = cloneJsonValue(operationData.requestTemplate) as Record<string, unknown>;
  for (const key of operationData.requiredRequestKeys) {
    if (!hasOwn(values, key) || values[key] === undefined) {
      throw new Error(`Expression owner request is missing ${key}.`);
    }
    const nullableCapabilityRevision = operation === 'capabilities'
      && (key === 'registry_revision' || key === 'expected_policy_revision');
    if (values[key] === null && !nullableCapabilityRevision) {
      throw new Error(`Expression owner request ${key} cannot be null.`);
    }
    insertPath(request, descriptor.requestPaths[key], values[key]);
  }
  return request;
}

export interface DecodedExpressionOwnerReply {
  operation: ExpressionOwnerOperation;
  values: Readonly<Partial<Record<ExpressionReplySemanticKey, unknown>>>;
  canonicalReply: string;
}

const ARRAY_REPLY_KEYS = new Set<ExpressionReplySemanticKey>([
  'static_dependencies',
  'diagnostics',
  'functions',
]);

const NULLABLE_REPLY_KEYS = new Set<ExpressionReplySemanticKey>([
  'source',
  'canonical_source',
  'completion',
  'evaluation_result',
  'evaluation_readset',
  'legacy_projection',
]);

/** Reads only operation-required semantic selectors. Every selector must be
 * present. Protocol-declared optional payloads remain present as JSON null;
 * nested evaluation_result null is also a real evaluated value. */
export function decodeExpressionOwnerReply(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  operation: ExpressionOwnerOperation,
  reply: unknown,
): DecodedExpressionOwnerReply {
  if (!isRecord(reply)) throw new Error('Expression owner reply must be an object.');
  const values: Partial<Record<ExpressionReplySemanticKey, unknown>> = {};
  for (const key of operationDescriptor(descriptor, operation).requiredReplyKeys) {
    const selected = readPath(reply, descriptor.replyPaths[key]);
    if (!selected.present || (selected.value === null && !NULLABLE_REPLY_KEYS.has(key))) {
      throw new Error(`Expression owner reply is missing ${key}.`);
    }
    if (ARRAY_REPLY_KEYS.has(key) && !Array.isArray(selected.value)) {
      throw new Error(`Expression owner reply ${key} must be an array.`);
    }
    values[key] = selected.value;
  }
  if (values.operation !== operation) {
    throw new Error(`Expression owner replied to ${String(values.operation)} while ${operation} is active.`);
  }
  for (const key of ['request_token', 'source_revision', 'catalog_revision', 'registry_revision', 'policy_revision'] as const) {
    if (hasOwn(values, key) && (typeof values[key] !== 'string' || !(values[key] as string).trim())) {
      throw new Error(`Expression owner reply ${key} must be a non-empty string.`);
    }
  }
  return { operation, values, canonicalReply: canonicalExpressionOwnerJson(reply) };
}

export interface ExpressionOwnerGuardState {
  target: string;
  descriptorRevision: string;
  requestToken: string;
  sourceRevision: string;
  catalogRevision: string;
  registryRevision: string | null;
  policyRevision: string | null;
}

export interface GuardedExpressionOwnerReply {
  target: string;
  descriptorRevision: string;
  decoded: DecodedExpressionOwnerReply;
}

export interface ExpressionOwnerReplyAcceptance {
  accepted: boolean;
  reason?: 'target' | 'descriptor_revision' | 'request_token' | 'source_revision' | 'catalog_revision' | 'registry_revision' | 'policy_revision';
  nextRegistryRevision?: string;
  nextPolicyRevision?: string;
}

/** Latest-only acceptance over the complete owner guard tuple. Capabilities is
 * the bootstrap/refresh operation: matching local identity accepts the owner's
 * current non-empty registry and policy revisions atomically. */
export function acceptExpressionOwnerReply(
  current: ExpressionOwnerGuardState,
  candidate: GuardedExpressionOwnerReply,
): ExpressionOwnerReplyAcceptance {
  if (candidate.target !== current.target) return { accepted: false, reason: 'target' };
  if (candidate.descriptorRevision !== current.descriptorRevision) {
    return { accepted: false, reason: 'descriptor_revision' };
  }
  const values = candidate.decoded.values;
  const guards = [
    ['request_token', 'requestToken'],
    ['source_revision', 'sourceRevision'],
    ['catalog_revision', 'catalogRevision'],
  ] as const;
  for (const [replyKey, stateKey] of guards) {
    if (values[replyKey] !== current[stateKey]) return { accepted: false, reason: replyKey };
  }
  const registryRevision = values.registry_revision as string;
  const policyRevision = values.policy_revision as string;
  if (candidate.decoded.operation === 'capabilities') {
    return {
      accepted: true,
      nextRegistryRevision: registryRevision,
      nextPolicyRevision: policyRevision,
    };
  }
  if (registryRevision !== current.registryRevision) {
    return { accepted: false, reason: 'registry_revision' };
  }
  if (policyRevision !== current.policyRevision) {
    return { accepted: false, reason: 'policy_revision' };
  }
  return { accepted: true };
}

export interface ExpressionRevisionMatrixRow {
  id: string;
  operation: ExpressionOwnerOperation;
  target: string;
  scenario: 'guard' | 'lifecycle';
  changed: readonly string[];
  accepted: boolean;
  reason?: string;
  terminalState:
    | 'accepted'
    | 'discarded_stale'
    | 'catalog_replaced'
    | 'duplicate_ignored'
    | 'source_saved'
    | 'save_conflict'
    | 'source_saved_evaluation_pending'
    | 'draft_reanalysis_required';
  durableWriteCount: 0 | 1;
}

const LIFECYCLE_ROWS: readonly Omit<ExpressionRevisionMatrixRow, 'id' | 'operation' | 'target'>[] = [
  {
    scenario: 'lifecycle',
    changed: ['cancel_before_reply'],
    accepted: false,
    reason: 'cancel_before_reply',
    terminalState: 'discarded_stale',
    durableWriteCount: 0,
  },
  {
    scenario: 'lifecycle',
    changed: ['cancel_after_reply_before_reduction'],
    accepted: false,
    reason: 'cancel_after_reply_before_reduction',
    terminalState: 'discarded_stale',
    durableWriteCount: 0,
  },
  {
    scenario: 'lifecycle',
    changed: ['duplicate_reply'],
    accepted: false,
    reason: 'duplicate_reply',
    terminalState: 'duplicate_ignored',
    durableWriteCount: 0,
  },
  {
    scenario: 'lifecycle',
    changed: ['timeout_then_late_reply'],
    accepted: false,
    reason: 'timeout_then_late_reply',
    terminalState: 'discarded_stale',
    durableWriteCount: 0,
  },
  {
    scenario: 'lifecycle',
    changed: ['cas_success_reply_lost_readback_match'],
    accepted: true,
    terminalState: 'source_saved',
    durableWriteCount: 1,
  },
  {
    scenario: 'lifecycle',
    changed: ['cas_conflict'],
    accepted: false,
    reason: 'cas_conflict',
    terminalState: 'save_conflict',
    durableWriteCount: 0,
  },
  {
    scenario: 'lifecycle',
    changed: ['descriptor_revision_during_commit'],
    accepted: true,
    terminalState: 'source_saved_evaluation_pending',
    durableWriteCount: 1,
  },
  {
    scenario: 'lifecycle',
    changed: ['policy_revision_during_commit'],
    accepted: true,
    terminalState: 'source_saved_evaluation_pending',
    durableWriteCount: 1,
  },
  {
    scenario: 'lifecycle',
    changed: ['catalog_revision_during_pick'],
    accepted: false,
    reason: 'catalog_revision_during_pick',
    terminalState: 'draft_reanalysis_required',
    durableWriteCount: 0,
  },
  {
    scenario: 'lifecycle',
    changed: ['registry_revision_during_cached_insertion'],
    accepted: false,
    reason: 'registry_revision_during_cached_insertion',
    terminalState: 'catalog_replaced',
    durableWriteCount: 0,
  },
];

/** Generates the hostile latest-reply matrix from generic guard dimensions.
 * No evaluator target or language name appears in this physics. */
export function buildExpressionRevisionMatrix(
  targets: readonly string[],
): readonly ExpressionRevisionMatrixRow[] {
  const operations: readonly ExpressionOwnerOperation[] = ['analyze', 'evaluate', 'capabilities', 'project_source'];
  const dimensions = [
    'descriptor_revision',
    'request_token',
    'source_revision',
    'catalog_revision',
    'registry_revision',
    'policy_revision',
  ] as const;
  const rows: ExpressionRevisionMatrixRow[] = [];
  for (const operation of operations) for (const target of targets) {
    rows.push({
      id: `${operation}:${target}:match`,
      operation,
      target,
      scenario: 'guard',
      changed: [],
      accepted: true,
      terminalState: 'accepted',
      durableWriteCount: 0,
    });
    rows.push({
      id: `${operation}:${target}:target`,
      operation,
      target,
      scenario: 'guard',
      changed: ['target'],
      accepted: false,
      reason: 'target',
      terminalState: 'discarded_stale',
      durableWriteCount: 0,
    });
    for (let mask = 1; mask < (1 << dimensions.length); mask += 1) {
      const changed = dimensions.filter((_, index) => (mask & (1 << index)) !== 0);
      const refreshOnly = operation === 'capabilities'
        && changed.every((dimension) => dimension === 'registry_revision' || dimension === 'policy_revision');
      rows.push({
        id: `${operation}:${target}:${changed.join('+')}`,
        operation,
        target,
        scenario: 'guard',
        changed,
        accepted: refreshOnly,
        ...(!refreshOnly ? { reason: changed[0] } : {}),
        terminalState: refreshOnly ? 'catalog_replaced' : 'discarded_stale',
        durableWriteCount: 0,
      });
    }
    for (const lifecycle of LIFECYCLE_ROWS) {
      rows.push({
        id: `${operation}:${target}:${lifecycle.changed[0]}`,
        operation,
        target,
        ...lifecycle,
      });
    }
  }
  return rows;
}

export function projectLegacyExpressionSource(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  values: ExpressionOwnerRequestValues,
): Record<string, unknown> {
  return composeExpressionOwnerRequest(descriptor, 'project_source', values);
}
