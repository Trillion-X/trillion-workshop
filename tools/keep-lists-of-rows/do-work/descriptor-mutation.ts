//
// Immutable, independently addressed descriptor mutations. A caller creates a
// draft from the exact owner snapshots it saw. Materialization compares that
// immutable basis with fresh current truth, rebases disjoint changes, and
// emits one actor-atomic CAS batch. Same-path changes preserve the draft and
// fail closed as an explicit conflict.

import type {
  MutationSettlementAttempt,
  MutationSettlementPolicy,
  MutationSettlementResult,
  MutationSettlementTransition,
} from './mutation-settlement';
import type { AddressedWrite, RecordWriter } from './record-writes';
import { isOrderKey, keyBetween } from './fractional-order';
import {
  descriptorAddressFor,
  descriptorKeyIdentity,
  normalizeDescriptorKey,
  type AddressedDescriptorSnapshot,
  type DescriptorFact,
  type DescriptorKey,
  type DescriptorOwnerTarget,
} from '../read-data/addressed-descriptors';

type DescriptorPath = readonly string[];

interface CreateDescriptorOperation {
  operation: 'create';
  key: DescriptorKey;
  value: unknown;
}

interface SetDescriptorOperation {
  operation: 'set';
  key: DescriptorKey;
  path: DescriptorPath;
  beforePresent?: boolean;
  before: unknown;
  after: unknown;
}

interface RemoveDescriptorOperation {
  operation: 'remove';
  key: DescriptorKey;
  path: DescriptorPath;
  before: unknown;
}

export interface MoveDescriptorOperation {
  operation: 'move';
  key: DescriptorKey;
  beforeId?: string;
  afterId?: string;
  before: string | null;
  after: string;
}

interface DeleteDescriptorOperation {
  operation: 'delete';
  key: DescriptorKey;
  before: unknown;
}

export type DescriptorOperation =
  | CreateDescriptorOperation
  | SetDescriptorOperation
  | RemoveDescriptorOperation
  | MoveDescriptorOperation
  | DeleteDescriptorOperation;

export interface DescriptorMutationBasis {
  key: DescriptorKey;
  addressLabel: string;
  pathLabels: readonly string[];
  payload: DescriptorFact;
  /** Frozen byte values. Typed arrays cannot be made runtime-immutable, so a
   * draft never exposes its CAS basis through a mutable Uint8Array view. */
  payloadHash: readonly number[];
}

export interface DescriptorMutationDraft {
  draftId: string;
  operations: readonly DescriptorOperation[];
  bases: readonly DescriptorMutationBasis[];
  integrityScopes: readonly DescriptorKey[];
  requiredCurrentKeys: readonly DescriptorKey[];
  forbiddenCurrentKeys: readonly DescriptorKey[];
}

export interface DescriptorMutationConflict {
  key: DescriptorKey;
  addressLabel: string;
  operation: DescriptorOperation;
  reason:
    | 'basis-missing'
    | 'current-missing'
    | 'create-collision'
    | 'same-path-change'
    | 'delete-changed'
    | 'invalid-order-neighbor'
    | 'parent-missing'
    | 'parent-has-children'
    | 'required-reference-missing'
    | 'reference-present'
    | 'integrity-generation-changed';
  base: DescriptorFact | null;
  current: DescriptorFact | null;
}

export interface DescriptorExpectedProjection {
  addressLabel: string;
  payload: DescriptorFact | null;
}

export interface DescriptorMaterialization {
  state: 'ready' | 'deduplicated' | 'conflict';
  draft: DescriptorMutationDraft;
  writes: readonly AddressedWrite[];
  expected: readonly DescriptorExpectedProjection[];
  conflicts: readonly DescriptorMutationConflict[];
  rebasedKeys: readonly string[];
}

export interface DescriptorMutationOutcome {
  state: 'saved' | 'conflict' | 'failed' | 'timeout' | 'stale';
  draft: DescriptorMutationDraft;
  preserveDraft: boolean;
  reusedAcceptance: boolean;
  error?: unknown;
}

export type DescriptorConflictResolutionChoice = 'mine' | 'saved';

export type DescriptorSettlementObservation = readonly DescriptorExpectedProjection[];

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const ABSENT = Symbol('descriptor-path-absent');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    ) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value instanceof Uint8Array) return value;
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length
      && left.every((value, index) => value === right[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(right, key)
          && sameValue(left[key], right[key]),
      );
  }
  return false;
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function normalizedPath(path: DescriptorPath): readonly string[] {
  if (path.length === 0) throw new Error('Descriptor mutation path must not be empty.');
  return path.map((segment) => {
    const normalized = segment.normalize('NFC').trim();
    if (!normalized || FORBIDDEN_PATH_SEGMENTS.has(normalized)) {
      throw new Error(`Descriptor mutation path contains an invalid segment: "${segment}".`);
    }
    return normalized;
  });
}

function pathValue(root: unknown, path: DescriptorPath): unknown | typeof ABSENT {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return ABSENT;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return ABSENT;
    }
    current = current[segment];
  }
  return current;
}

function updatePath(
  root: unknown,
  path: DescriptorPath,
  value: unknown | typeof ABSENT,
): unknown {
  const [segment, ...rest] = path;
  if (segment === undefined) return value === ABSENT ? undefined : cloneValue(value);
  const container = Array.isArray(root)
    ? [...root]
    : isRecord(root) ? { ...root } : {};
  if (rest.length === 0) {
    if (value === ABSENT) {
      if (Array.isArray(container)) {
        const index = Number(segment);
        if (Number.isInteger(index) && index >= 0 && index < container.length) {
          container.splice(index, 1);
        }
      } else {
        delete container[segment];
      }
    } else {
      (container as Record<string, unknown>)[segment] = cloneValue(value);
    }
    return container;
  }
  const child = Array.isArray(container)
    ? container[Number(segment)]
    : container[segment];
  const updated = updatePath(child, rest, value);
  if (Array.isArray(container)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Descriptor mutation array path is invalid: "${segment}".`);
    }
    container[index] = updated;
  } else {
    container[segment] = updated;
  }
  return container;
}

function fact(key: DescriptorKey, value: unknown): DescriptorFact {
  return {
    kind: 'visual-database.descriptor',
    schema_version: 3,
    key: normalizeDescriptorKey(key),
    value: cloneValue(value),
  };
}

const DESCRIPTOR_INTEGRITY_GENERATION_FAMILY = 'descriptor-integrity-generation';

export function descriptorIntegrityGenerationKey(scope: DescriptorKey): DescriptorKey {
  return {
    family: DESCRIPTOR_INTEGRITY_GENERATION_FAMILY,
    id: descriptorKeyIdentity(scope),
  };
}

function uniqueDescriptorKeys(keys: readonly DescriptorKey[]): readonly DescriptorKey[] {
  const result = new Map<string, DescriptorKey>();
  for (const key of keys) {
    const normalized = normalizeDescriptorKey(key);
    result.set(descriptorKeyIdentity(normalized), normalized);
  }
  return [...result.values()];
}

export function descriptorIntegrityScopesForOperations(
  operations: readonly DescriptorOperation[],
): readonly DescriptorKey[] {
  return uniqueDescriptorKeys(operations.flatMap((operation) => [
    ...(operation.key.parent ?? []).map((parent) => ({
      family: parent.family,
      id: parent.id,
    })),
    ...(operation.operation === 'delete' ? [operation.key] : []),
  ]));
}

function immutableOperation(operation: DescriptorOperation): DescriptorOperation {
  const key = normalizeDescriptorKey(operation.key);
  switch (operation.operation) {
    case 'create':
      return deepFreeze({ ...operation, key, value: cloneValue(operation.value) });
    case 'set':
      return deepFreeze({
        ...operation,
        key,
        path: normalizedPath(operation.path),
        beforePresent: operation.beforePresent !== false,
        before: cloneValue(operation.before),
        after: cloneValue(operation.after),
      });
    case 'remove':
      return deepFreeze({
        ...operation,
        key,
        path: normalizedPath(operation.path),
        before: cloneValue(operation.before),
      });
    case 'move':
      if (!isOrderKey(operation.after)) {
        throw new Error('Descriptor move operation requires a valid immutable order key.');
      }
      if (operation.before !== null && !isOrderKey(operation.before)) {
        throw new Error('Descriptor move operation has an invalid prior order key.');
      }
      return deepFreeze({
        ...operation,
        key,
        ...(operation.beforeId ? { beforeId: operation.beforeId.normalize('NFC').trim() } : {}),
        ...(operation.afterId ? { afterId: operation.afterId.normalize('NFC').trim() } : {}),
      });
    case 'delete':
      return deepFreeze({ ...operation, key, before: cloneValue(operation.before) });
  }
}

export function createDescriptorMutationDraft(input: {
  draftId: string;
  operations: readonly DescriptorOperation[];
  bases: readonly AddressedDescriptorSnapshot[];
  integrityScopes?: readonly DescriptorKey[];
  requiredCurrentKeys?: readonly DescriptorKey[];
  forbiddenCurrentKeys?: readonly DescriptorKey[];
}): DescriptorMutationDraft {
  const draftId = input.draftId.normalize('NFC').trim();
  if (!draftId) throw new Error('Descriptor mutation draft requires an identity.');
  if (input.operations.length === 0) {
    throw new Error('Descriptor mutation draft requires at least one operation.');
  }
  const bases = input.bases.map((basis) => deepFreeze({
    key: normalizeDescriptorKey(basis.key),
    addressLabel: basis.addressLabel,
    pathLabels: [...basis.pathLabels],
    payload: cloneValue(basis.payload),
    payloadHash: [...basis.payloadHash],
  }));
  const identities = bases.map((basis) => descriptorKeyIdentity(basis.key));
  if (new Set(identities).size !== identities.length) {
    throw new Error('Descriptor mutation draft contains duplicate bases.');
  }
  const operations = input.operations.map(immutableOperation);
  return deepFreeze({
    draftId,
    operations,
    bases,
    integrityScopes: uniqueDescriptorKeys([
      ...descriptorIntegrityScopesForOperations(operations),
      ...(input.integrityScopes ?? []),
    ]),
    requiredCurrentKeys: uniqueDescriptorKeys(input.requiredCurrentKeys ?? []),
    forbiddenCurrentKeys: uniqueDescriptorKeys(input.forbiddenCurrentKeys ?? []),
  });
}

function relatedKey(key: DescriptorKey, id: string): DescriptorKey {
  return {
    family: key.family,
    id,
    ...(key.parent ? { parent: key.parent } : {}),
  };
}

function orderOf(snapshot: AddressedDescriptorSnapshot | undefined): string | null {
  const value = snapshot?.payload.value;
  if (!isRecord(value)) return null;
  return isOrderKey(value.order) ? value.order : null;
}

export function createMoveDescriptorOperation(input: {
  key: DescriptorKey;
  current: readonly AddressedDescriptorSnapshot[];
  beforeId?: string;
  afterId?: string;
}): MoveDescriptorOperation {
  const current = new Map(
    input.current.map((snapshot) => [descriptorKeyIdentity(snapshot.key), snapshot]),
  );
  const moving = current.get(descriptorKeyIdentity(input.key));
  if (!moving) throw new Error('Descriptor move basis is missing.');
  const beforeOrder = input.beforeId
    ? orderOf(current.get(descriptorKeyIdentity(relatedKey(input.key, input.beforeId))))
    : null;
  const afterOrder = input.afterId
    ? orderOf(current.get(descriptorKeyIdentity(relatedKey(input.key, input.afterId))))
    : null;
  if ((input.beforeId && beforeOrder === null) || (input.afterId && afterOrder === null)) {
    throw new Error('Descriptor move neighbor is missing a valid order key.');
  }
  return {
    operation: 'move',
    key: normalizeDescriptorKey(input.key),
    ...(input.beforeId ? { beforeId: input.beforeId } : {}),
    ...(input.afterId ? { afterId: input.afterId } : {}),
    before: orderOf(moving),
    after: keyBetween(beforeOrder, afterOrder),
  };
}

function conflict(
  target: DescriptorOwnerTarget,
  operation: DescriptorOperation,
  reason: DescriptorMutationConflict['reason'],
  base: DescriptorFact | null,
  current: DescriptorFact | null,
): DescriptorMutationConflict {
  return {
    key: operation.key,
    addressLabel: descriptorAddressFor(target, operation.key),
    operation,
    reason,
    base,
    current,
  };
}

export function materializeDescriptorOperations(input: {
  target: DescriptorOwnerTarget;
  draft: DescriptorMutationDraft;
  current: readonly AddressedDescriptorSnapshot[];
}): DescriptorMaterialization {
  const currentByKey = new Map(
    input.current.map((snapshot) => [descriptorKeyIdentity(snapshot.key), snapshot]),
  );
  if (currentByKey.size !== input.current.length) {
    throw new Error('Descriptor materialization received duplicate current snapshots.');
  }
  const baseByKey = new Map(
    input.draft.bases.map((basis) => [descriptorKeyIdentity(basis.key), basis]),
  );
  const working = new Map<string, DescriptorFact | null>();
  const touched = new Map<string, {
    key: DescriptorKey;
    addressLabel: string;
    pathLabels: readonly string[];
    initial: AddressedDescriptorSnapshot | undefined;
  }>();
  const conflicts: DescriptorMutationConflict[] = [];
  const rebasedKeys = new Set<string>();
  const finalKeys = new Map(
    input.current.map((snapshot) => [descriptorKeyIdentity(snapshot.key), snapshot.key]),
  );
  const finalPresent = new Set(finalKeys.keys());
  for (const operation of input.draft.operations) {
    const identity = descriptorKeyIdentity(operation.key);
    finalKeys.set(identity, operation.key);
    if (operation.operation === 'create') finalPresent.add(identity);
    else if (operation.operation === 'delete') finalPresent.delete(identity);
  }
  const firstOperation = input.draft.operations[0]!;

  for (const required of input.draft.requiredCurrentKeys) {
    const identity = descriptorKeyIdentity(required);
    if (!finalPresent.has(identity)) {
      conflicts.push(conflict(
        input.target,
        firstOperation,
        'required-reference-missing',
        null,
        null,
      ));
    }
  }
  for (const forbidden of input.draft.forbiddenCurrentKeys) {
    const identity = descriptorKeyIdentity(forbidden);
    const present = currentByKey.get(identity);
    if (finalPresent.has(identity)) {
      conflicts.push(conflict(
        input.target,
        firstOperation,
        'reference-present',
        null,
        present?.payload ?? null,
      ));
    }
  }
  for (const operation of input.draft.operations) {
    if (operation.operation !== 'delete') {
      for (const parent of operation.key.parent ?? []) {
        const parentKey = { family: parent.family, id: parent.id };
        const parentIdentity = descriptorKeyIdentity(parentKey);
        if (!finalPresent.has(parentIdentity)) {
          conflicts.push(conflict(
            input.target,
            operation,
            'parent-missing',
            null,
            null,
          ));
        }
      }
    }
    if (operation.operation !== 'delete') continue;
    const deletingIdentity = descriptorKeyIdentity(operation.key);
    const survivingChild = [...finalKeys.entries()].find(([childIdentity, childKey]) => (
      finalPresent.has(childIdentity)
      && childKey.parent?.some((parent) => descriptorKeyIdentity({
        family: parent.family,
        id: parent.id,
      }) === deletingIdentity)
    ));
    if (survivingChild) {
      const survivingSnapshot = currentByKey.get(survivingChild[0]);
      conflicts.push(conflict(
        input.target,
        operation,
        'parent-has-children',
        baseByKey.get(deletingIdentity)?.payload ?? null,
        survivingSnapshot?.payload ?? null,
      ));
    }
  }

  for (const operation of input.draft.operations) {
    const identity = descriptorKeyIdentity(operation.key);
    const initial = currentByKey.get(identity);
    const base = baseByKey.get(identity);
    const addressLabel = descriptorAddressFor(input.target, operation.key);
    const currentFact = working.has(identity)
      ? working.get(identity) ?? null
      : initial?.payload ?? null;
    touched.set(identity, {
      key: operation.key,
      addressLabel,
      pathLabels: initial?.pathLabels ?? base?.pathLabels ?? input.target.pathLabels,
      initial,
    });

    if (operation.operation === 'create') {
      const desired = fact(operation.key, operation.value);
      if (currentFact === null) working.set(identity, desired);
      else if (!sameValue(currentFact, desired)) {
        conflicts.push(conflict(input.target, operation, 'create-collision', base?.payload ?? null, currentFact));
      } else working.set(identity, currentFact);
      continue;
    }
    if (!base) {
      conflicts.push(conflict(input.target, operation, 'basis-missing', null, currentFact));
      continue;
    }
    if (operation.operation === 'delete') {
      if (currentFact === null) {
        working.set(identity, null);
      } else if (
        sameValue(currentFact.value, operation.before)
        || (initial !== undefined && sameBytes(initial.payloadHash, base.payloadHash))
      ) {
        working.set(identity, null);
      } else {
        conflicts.push(conflict(input.target, operation, 'delete-changed', base.payload, currentFact));
      }
      continue;
    }
    if (currentFact === null) {
      conflicts.push(conflict(input.target, operation, 'current-missing', base.payload, null));
      continue;
    }

    const path = operation.operation === 'move' ? ['order'] : operation.path;
    const before = operation.before;
    const after = operation.operation === 'remove' ? ABSENT : operation.after;
    const observed = pathValue(currentFact.value, path);
    if (after === ABSENT ? observed === ABSENT : sameValue(observed, after)) {
      working.set(identity, currentFact);
      continue;
    }
    const basisMatches = operation.operation === 'set' && operation.beforePresent === false
      ? observed === ABSENT
      : before === null && operation.operation === 'move'
        ? observed === ABSENT
        : sameValue(observed, before);
    if (!basisMatches) {
      conflicts.push(conflict(input.target, operation, 'same-path-change', base.payload, currentFact));
      continue;
    }
    if (initial && !sameBytes(initial.payloadHash, base.payloadHash)) rebasedKeys.add(identity);
    working.set(identity, fact(operation.key, updatePath(currentFact.value, path, after)));
  }

  for (const scope of input.draft.integrityScopes) {
    const generationKey = descriptorIntegrityGenerationKey(scope);
    const identity = descriptorKeyIdentity(generationKey);
    const initial = currentByKey.get(identity);
    const basis = baseByKey.get(identity);
    const basisMatches = basis === undefined
      ? initial === undefined
      : initial !== undefined && sameBytes(initial.payloadHash, basis.payloadHash);
    if (!basisMatches) {
      conflicts.push(conflict(
        input.target,
        firstOperation,
        'integrity-generation-changed',
        basis?.payload ?? null,
        initial?.payload ?? null,
      ));
      continue;
    }
    const addressLabel = descriptorAddressFor(input.target, generationKey);
    const desired = fact(generationKey, { revision: input.draft.draftId });
    touched.set(identity, {
      key: generationKey,
      addressLabel,
      pathLabels: initial?.pathLabels ?? input.target.pathLabels,
      initial,
    });
    working.set(identity, desired);
  }

  if (conflicts.length > 0) {
    return {
      state: 'conflict',
      draft: input.draft,
      writes: [],
      expected: [],
      conflicts,
      rebasedKeys: [...rebasedKeys],
    };
  }

  const writes: AddressedWrite[] = [];
  const expected: DescriptorExpectedProjection[] = [];
  for (const [identity, descriptor] of touched) {
    const desired = working.get(identity) ?? null;
    expected.push({ addressLabel: descriptor.addressLabel, payload: desired });
    if (sameValue(descriptor.initial?.payload ?? null, desired)) continue;
    writes.push({
      addressLabel: descriptor.addressLabel,
      pathLabels: descriptor.pathLabels,
      payload: desired,
      expectedCurrent: descriptor.initial
        ? { payloadHash: new Uint8Array(descriptor.initial.payloadHash) }
        : null,
    });
  }
  return {
    state: writes.length === 0 ? 'deduplicated' : 'ready',
    draft: input.draft,
    writes,
    expected,
    conflicts: [],
    rebasedKeys: [...rebasedKeys],
  };
}

export function threeWayRebaseDescriptorOperations(input: {
  target: DescriptorOwnerTarget;
  draft: DescriptorMutationDraft;
  current: readonly AddressedDescriptorSnapshot[];
}): DescriptorMaterialization {
  return materializeDescriptorOperations(input);
}

function sameProjection(
  observed: DescriptorSettlementObservation,
  expected: readonly DescriptorExpectedProjection[],
): boolean {
  if (observed.length !== expected.length) return false;
  const observedByAddress = new Map(
    observed.map((projection) => [projection.addressLabel, projection.payload]),
  );
  return observedByAddress.size === observed.length
    && expected.every(
      (projection) => observedByAddress.has(projection.addressLabel)
        && sameValue(observedByAddress.get(projection.addressLabel), projection.payload),
    );
}

export function buildDescriptorSettlementAttempt(input: {
  attemptId: string;
  scope: string;
  materialization: DescriptorMaterialization;
  writer: Pick<RecordWriter, 'batch'>;
  observeFeed: () => DescriptorSettlementObservation | null
    | Promise<DescriptorSettlementObservation | null>;
  readCurrent: () => DescriptorSettlementObservation | null
    | Promise<DescriptorSettlementObservation | null>;
  policy: MutationSettlementPolicy;
  onTransition?: (transition: MutationSettlementTransition) => void;
}): MutationSettlementAttempt<
  readonly DescriptorExpectedProjection[],
  DescriptorSettlementObservation
> {
  if (input.materialization.state === 'conflict') {
    throw new Error('Conflicted descriptor operations cannot reach transport.');
  }
  const attemptId = input.attemptId.normalize('NFC').trim();
  const scope = input.scope.normalize('NFC').trim();
  if (!attemptId || !scope) {
    throw new Error('Descriptor settlement requires attempt and scope identities.');
  }
  return {
    attemptId,
    scope,
    authorityKeys: input.materialization.expected.map(({ addressLabel }) => addressLabel),
    expected: input.materialization.expected,
    write: () => input.writer.batch(input.materialization.writes),
    observeFeed: input.observeFeed,
    readCurrent: input.readCurrent,
    matches: sameProjection,
    classifyCurrent: (observed, expected) => (
      observed !== null && !sameProjection(observed, expected) ? 'conflict' : null
    ),
    policy: input.policy,
    ...(input.onTransition ? { onTransition: input.onTransition } : {}),
  };
}

export function descriptorMutationResultFromSettlement(
  draft: DescriptorMutationDraft,
  settlement: MutationSettlementResult,
): DescriptorMutationOutcome {
  return {
    state: settlement.state,
    draft,
    preserveDraft: settlement.state !== 'saved',
    reusedAcceptance: settlement.reusedAcceptance,
    ...(settlement.error === undefined ? {} : { error: settlement.error }),
  };
}

function rebasedConflictOperation(
  operation: DescriptorOperation,
  current: DescriptorFact | null,
): readonly DescriptorOperation[] {
  if (operation.operation === 'create') {
    if (current === null) return [operation];
    return [
      { operation: 'delete', key: operation.key, before: current.value },
      { operation: 'create', key: operation.key, value: operation.value },
    ];
  }
  if (current === null) {
    return operation.operation === 'delete' ? [] : [operation];
  }
  if (operation.operation === 'delete') {
    return [{ ...operation, before: current.value }];
  }
  const path = operation.operation === 'move' ? ['order'] : operation.path;
  const observed = pathValue(current.value, path);
  if (operation.operation === 'remove') {
    return observed === ABSENT ? [] : [{ ...operation, before: cloneValue(observed) }];
  }
  if (operation.operation === 'move') {
    return [{
      ...operation,
      before: observed === ABSENT ? null : typeof observed === 'string' ? observed : null,
    }];
  }
  return [{
    ...operation,
    beforePresent: observed !== ABSENT,
    before: observed === ABSENT ? undefined : cloneValue(observed),
  }];
}

/** Applies explicit user choices to a conflicted immutable draft. Unrelated
 * operations remain in the draft; "saved" drops only the selected conflict,
 * while "mine" rebases only that operation against fresh owner truth. */
export function resolveDescriptorMutationConflictDraft(input: {
  draftId: string;
  draft: DescriptorMutationDraft;
  conflicts: readonly DescriptorMutationConflict[];
  current: readonly AddressedDescriptorSnapshot[];
  choices: ReadonlyMap<number, DescriptorConflictResolutionChoice>;
}): DescriptorMutationDraft | null {
  const conflictByOperation = new Map<DescriptorOperation, number[]>();
  input.conflicts.forEach((entry, index) => {
    // The integrity generation is infrastructure concurrency state, not a
    // user-authored property. It must never borrow the first user operation's
    // identity or turn "Use saved" into permission to discard that edit.
    // Recreating the draft below refreshes the generation basis from the
    // independently read current snapshots while preserving every user
    // operation that has no real property conflict.
    if (entry.reason === 'integrity-generation-changed') return;
    const existing = conflictByOperation.get(entry.operation);
    if (existing) existing.push(index);
    else conflictByOperation.set(entry.operation, [index]);
  });
  const currentByKey = new Map(
    input.current.map((snapshot) => [descriptorKeyIdentity(snapshot.key), snapshot]),
  );
  const operations: DescriptorOperation[] = [];

  for (const operation of input.draft.operations) {
    const conflictIndexes = conflictByOperation.get(operation) ?? [];
    if (conflictIndexes.length === 0) {
      operations.push(operation);
      continue;
    }
    const unresolved = conflictIndexes.find((index) => !input.choices.has(index));
    if (unresolved !== undefined) {
      throw new Error('Every descriptor conflict requires an explicit resolution choice.');
    }
    if (conflictIndexes.every((index) => input.choices.get(index) === 'saved')) {
      continue;
    }
    const current = currentByKey.get(descriptorKeyIdentity(operation.key))?.payload ?? null;
    operations.push(...rebasedConflictOperation(operation, current));
  }

  if (operations.length === 0) return null;
  const touched = new Set(operations.map((operation) => descriptorKeyIdentity(operation.key)));
  return createDescriptorMutationDraft({
    draftId: input.draftId,
    operations,
    bases: input.current.filter((snapshot) => (
      touched.has(descriptorKeyIdentity(snapshot.key))
      || input.draft.integrityScopes.some((scope) => (
        descriptorKeyIdentity(descriptorIntegrityGenerationKey(scope))
          === descriptorKeyIdentity(snapshot.key)
      ))
    )),
    integrityScopes: input.draft.integrityScopes,
    requiredCurrentKeys: input.draft.requiredCurrentKeys,
    forbiddenCurrentKeys: input.draft.forbiddenCurrentKeys,
  });
}
