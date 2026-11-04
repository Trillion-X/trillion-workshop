// Pure cell-source settlement predicates and write assembly. This module is
// safe for presentation/shared-view imports; direct owner reads stay in the
// sibling cell-source-mutation.ts adapter.

import type {
  VisualDatabaseCellRef,
  VisualDatabaseValueExpression,
} from '../read-data/visual-database';
import type { AddressedCellValueRecord } from './cell-expression';
import {
  addressedCellValueLabels,
  buildAddressedCellValueWrites,
  visualDatabaseValueExpressionPayload,
  type AddressedWrite,
} from './record-write-builders';
import type {
  MutationSettlementAttempt,
  MutationSettlementPolicy,
  MutationSettlementResult,
  MutationSettlementTransition,
} from './mutation-settlement';

export interface CellSourceSettlementPorts {
  write: (writes: readonly AddressedWrite[]) => Promise<unknown>;
  read: (cellRef: VisualDatabaseCellRef) => Promise<AddressedCellValueRecord | null>;
  waitForFeed: (
    cellRef: VisualDatabaseCellRef,
    revision: string,
    timeoutMs: number,
  ) => Promise<AddressedCellValueRecord | null>;
}

export interface CellSourceMutationDraft {
  cellRef: VisualDatabaseCellRef;
  expression: VisualDatabaseValueExpression;
  sourceRevision: string;
  sourceExpectedCurrent: { payloadHash: Uint8Array } | null;
}

export type CellSourceMutationState =
  | 'editing'
  | 'saving'
  | 'awaiting-readback'
  | 'saved'
  | 'conflict'
  | 'failed'
  | 'unknown';

interface CellSourceMutationResultBase {
  draft: CellSourceMutationDraft;
  current: AddressedCellValueRecord | null;
  feedMatch: AddressedCellValueRecord | null;
  writeError?: unknown;
  readError?: unknown;
}

export type CellSourceMutationResult =
  | CellSourceMutationResultBase & {
    state: 'saved';
    current: AddressedCellValueRecord;
    feedMatch: AddressedCellValueRecord;
    readbackIdentity: string;
  }
  | CellSourceMutationResultBase & {
    state: Extract<CellSourceMutationState, 'conflict' | 'failed' | 'unknown'>;
    readbackIdentity?: never;
  };

export interface CreateCellSourceMutationDraftInput {
  cellRef: VisualDatabaseCellRef;
  expression: VisualDatabaseValueExpression;
  sourceExpectedCurrent?: { payloadHash: Uint8Array } | null;
  allocateRevision: () => string;
}

/** Allocate the source revision once, when the draft is created. Exact retries
 * reuse this immutable value and the original CAS basis. */
export function createCellSourceMutationDraft(
  input: CreateCellSourceMutationDraftInput,
): CellSourceMutationDraft {
  const sourceRevision = input.allocateRevision().trim();
  if (!sourceRevision) throw new Error('A cell source draft requires a source revision');
  return {
    cellRef: { ...input.cellRef },
    expression: input.expression,
    sourceRevision,
    sourceExpectedCurrent: input.sourceExpectedCurrent ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readCellRef(payload: unknown): VisualDatabaseCellRef | null {
  if (!isRecord(payload)) return null;
  const raw = payload.cell_ref ?? payload.cellRef;
  if (!isRecord(raw)) return null;
  const recordRef = raw.record_ref ?? raw.recordRef;
  const fieldRef = raw.field_ref ?? raw.fieldRef;
  return typeof recordRef === 'string' && typeof fieldRef === 'string'
    ? { recordRef, fieldRef }
    : null;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function basisEqual(
  left: AddressedCellValueRecord['expectedCurrent'],
  right: CellSourceMutationDraft['sourceExpectedCurrent'],
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return bytesEqual(left.payloadHash, right.payloadHash);
}

/** Exact source readback predicate. Cache/provenance rows cannot satisfy it,
 * and equivalent-but-different formulas cannot masquerade as this save. */
export function matchesCellSourceDraft(
  row: AddressedCellValueRecord | null,
  draft: CellSourceMutationDraft,
): boolean {
  if (!row || !isRecord(row.payload)) return false;
  const rowRef = readCellRef(row.payload);
  const revision = row.payload.revision;
  return !!rowRef
    && rowRef.recordRef === draft.cellRef.recordRef
    && rowRef.fieldRef === draft.cellRef.fieldRef
    && revision === draft.sourceRevision
    && deepEqual(row.payload.expression, visualDatabaseValueExpressionPayload(draft.expression));
}

function sourceWrite(draft: CellSourceMutationDraft): readonly AddressedWrite[] {
  return buildAddressedCellValueWrites({
    cellRef: draft.cellRef,
    expression: draft.expression,
    revision: draft.sourceRevision,
    sourceExpectedCurrent: draft.sourceExpectedCurrent,
  });
}

export interface BuildCellSourceSettlementAttemptOptions {
  attemptId: string;
  scope?: string;
  policy: MutationSettlementPolicy;
  onTransition?: (transition: MutationSettlementTransition) => void;
}

/**
 * Adapts one immutable cell-source draft to the generic settlement primitive.
 * Source-specific code supplies only addressing, write construction, and the
 * exact source predicate. The coordinator alone owns settlement transitions.
 */
export function buildCellSourceSettlementAttempt(
  draft: CellSourceMutationDraft,
  ports: CellSourceSettlementPorts,
  options: BuildCellSourceSettlementAttemptOptions,
): MutationSettlementAttempt<CellSourceMutationDraft, AddressedCellValueRecord> {
  const address = addressedCellValueLabels(draft.cellRef).expression;
  return {
    attemptId: options.attemptId,
    scope: options.scope ?? address,
    authorityKeys: [address],
    expected: draft,
    write: async () => {
      await ports.write(sourceWrite(draft));
    },
    observeFeed: () => ports.waitForFeed(
      draft.cellRef,
      draft.sourceRevision,
      options.policy.pollIntervalMs,
    ),
    readCurrent: () => ports.read(draft.cellRef),
    matches: matchesCellSourceDraft,
    classifyCurrent: (observed) => {
      if (matchesCellSourceDraft(observed, draft)) return null;
      return basisEqual(observed?.expectedCurrent ?? null, draft.sourceExpectedCurrent)
        ? 'failed'
        : 'conflict';
    },
    policy: options.policy,
    ...(options.onTransition ? { onTransition: options.onTransition } : {}),
  };
}

/**
 * Closes the Formula association carried by the coordinator's terminal owner
 * observations. The closed result exposes saved only with both exact source
 * observations and their immutable readback identity. This performs no owner
 * read; consumers render the closed result without reclassifying it.
 */
export function cellSourceMutationResultFromSettlement(
  draft: CellSourceMutationDraft,
  settlement: MutationSettlementResult<AddressedCellValueRecord>,
): CellSourceMutationResult {
  const { feed, readback, transport } = settlement.terminalObservation;
  const current = readback.value;
  const feedMatch = feed.status === 'matched' ? feed.value : null;
  if (settlement.state === 'saved') {
    if (feed.status !== 'matched'
      || readback.status !== 'matched'
      || !matchesCellSourceDraft(feedMatch, draft)
      || !matchesCellSourceDraft(current, draft)) {
      return {
        state: 'failed',
        draft,
        current,
        feedMatch,
        ...(transport.status === 'uncertain' ? { writeError: transport.error } : {}),
      };
    }
    return {
      state: 'saved',
      draft,
      current,
      feedMatch,
      readbackIdentity: draft.sourceRevision,
      ...(transport.status === 'uncertain' ? { writeError: transport.error } : {}),
    };
  }
  const state: CellSourceMutationResult['state'] = settlement.state === 'timeout'
    || settlement.state === 'stale'
    ? 'unknown'
    : settlement.state;
  const observationError = readback.status === 'error'
    ? readback.error
    : feed.status === 'error' ? feed.error : undefined;
  return {
    state,
    draft,
    current,
    feedMatch,
    ...(transport.status === 'uncertain' ? { writeError: transport.error } : {}),
    ...(observationError === undefined ? {} : { readError: observationError }),
  };
}
