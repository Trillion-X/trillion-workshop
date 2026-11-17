//
// Executable, data-driven adversarial proof for the generic expression-owner
// authoring primitive.  Matrix programs contain only concrete inputs and event
// sequences.  Every acceptance, terminal state, and write count below is
// observed from the production composer/decoder/guard/timeout/mutation
// operations; no fixture supplies an expected outcome.

import type {
  ExpressionOwnerOperation,
  ExpressionReplySemanticKey,
  ExpressionRequestSemanticKey,
  VisualDatabaseEvaluatorDescriptor,
  VisualDatabaseExpressionAuthoringDescriptor,
  VisualDatabaseValueExpression,
} from '../read-data/visual-database';
import {
  buildDurableExpressionOwnerRequest,
  canonicalExpressionOwnerJson,
  type ExpressionOwnerReplyAcceptance,
} from './expression-owner-protocol';
import {
  ExpressionOwnerReplyRejectedError,
  ExpressionOwnerSession,
  ExpressionOwnerSessionFactory,
  ExpressionOwnerStaleReplyError,
  type ExpressionOwnerSessionInput,
} from './expression-owner-session';
import type { AddressedCellValueRecord } from './cell-expression';
import {
  buildCellSourceSettlementAttempt,
  createCellSourceMutationDraft,
  type CellSourceMutationResult,
  type CellSourceMutationState,
} from './cell-source-mutation';
import {
  MutationSettlementCoordinator,
  type MutationSettlementPolicy,
} from './mutation-settlement';
import { visualDatabaseValueExpressionPayload } from './record-writes';

const OWN = Object.prototype.hasOwnProperty;
const GUARD_DIMENSIONS = [
  'descriptor_revision',
  'request_token',
  'source_revision',
  'catalog_revision',
  'registry_revision',
  'policy_revision',
] as const;
const EDIT_OPERATIONS = ['pick', 'replace', 'undo', 'redo'] as const;

export type ExpressionGuardDimension = (typeof GUARD_DIMENSIONS)[number];
export type ExpressionEditOperation = (typeof EDIT_OPERATIONS)[number];

export type ExpressionAuthoringPhase =
  | 'editing'
  | 'saving'
  | 'saved'
  | 'conflict'
  | 'failed'
  | 'unknown'
  | 'read_only'
  | 'source_saved_evaluation_pending'
  | 'draft_reanalysis_required';

export type ExpressionObservedPhase =
  | ExpressionAuthoringPhase
  | 'awaiting_owner'
  | 'accepted'
  | 'discarded_stale'
  | 'catalog_replaced'
  | 'duplicate_ignored'
  | 'cancelled'
  | 'timed_out';

export interface ExpressionEditSnapshot {
  source: string;
  selection: readonly [number, number];
  referenceIds: readonly string[];
}

export interface ExpressionEditTransaction {
  id: string;
  before: ExpressionEditSnapshot;
  after: ExpressionEditSnapshot;
}

export interface ExpressionAuthoringSession {
  phase: ExpressionAuthoringPhase;
  edit: ExpressionEditSnapshot;
  writable: boolean;
  history: readonly ExpressionEditTransaction[];
  future: readonly ExpressionEditTransaction[];
  evaluationPending: boolean;
}

export type ExpressionAuthoringEvent =
  | { type: 'set_writable'; writable: boolean }
  | { type: 'source_edited'; source: string; selection: readonly [number, number] }
  | { type: 'save_started' }
  | { type: 'save_settled'; state: CellSourceMutationResult['state'] }
  | { type: 'guard_changed'; dimension: ExpressionGuardDimension }
  | { type: 'edit_committed'; transaction: ExpressionEditTransaction }
  | { type: 'undo' }
  | { type: 'redo' };

export interface ExpressionReferenceInput {
  id: string;
  alias: string;
}

export interface ExpressionHostileMatrixProgram {
  schema: 'visual-database.expression-hostile-matrix/v2';
  operations: readonly ExpressionOwnerOperation[];
  guardDimensions: readonly ExpressionGuardDimension[];
  lifecyclePrograms: readonly ExpressionLifecycleProgram[];
  references: Readonly<Record<string, ExpressionReferenceInput>>;
}

export interface ExpressionLifecycleProgram {
  id: string;
  events: readonly ExpressionLifecycleProgramEvent[];
}

export type ExpressionLifecycleProgramEvent =
  | { type: 'request' }
  | { type: 'decode_reply' }
  | { type: 'reduce_reply' }
  | { type: 'cancel' }
  | { type: 'timeout' }
  | { type: 'late_reply' }
  | { type: 'set_writable'; value: boolean }
  | { type: 'edit_source'; suffix: string }
  | {
      type: 'save';
      transport: 'accept' | 'reject' | 'commit_then_throw';
      readback: 'match' | 'conflict' | 'same_basis' | 'error';
      feed: 'match' | 'missing';
    }
  | { type: 'change_guard'; dimension: ExpressionGuardDimension }
  | {
      type: 'edit';
      operation: Extract<ExpressionEditOperation, 'pick' | 'replace'>;
      references: readonly string[];
      selectionReference?: string;
    }
  | { type: Extract<ExpressionEditOperation, 'undo' | 'redo'> };

export interface ExpressionObservedRow {
  id: string;
  category: 'guard' | 'lifecycle' | 'owner_self_composition' | 'edit_self_composition';
  ownerRef: string;
  operation?: ExpressionOwnerOperation;
  pairedOperation?: ExpressionOwnerOperation | ExpressionEditOperation;
  changed: readonly string[];
  requestBytes: readonly string[];
  replyBytes: readonly string[];
  ownerAcceptances: readonly ExpressionOwnerReplyAcceptance[];
  transitions: readonly ExpressionObservedPhase[];
  terminalState: ExpressionObservedPhase;
  writeAttempts: number;
  acceptedDurableWrites: number;
  appliedReplyCount: number;
  duplicateReplyCount: number;
  mutationStates: readonly CellSourceMutationState[];
  editSnapshots: readonly ExpressionEditSnapshot[];
  edit: ExpressionEditSnapshot;
  historyDepth: number;
  redoDepth: number;
}

export interface ExpressionHostileMatrixReport {
  schema: 'visual-database.expression-hostile-matrix-report/v2';
  rows: readonly ExpressionObservedRow[];
  rowIds: readonly string[];
  totalCount: number;
  countsByCategory: Readonly<Record<ExpressionObservedRow['category'], number>>;
  countsByTerminalState: Readonly<Record<string, number>>;
  totalWriteAttempts: number;
  totalAcceptedDurableWrites: number;
  ownerWireIdentities: Readonly<Record<string, readonly string[]>>;
}

interface RowEffects {
  transitions: ExpressionObservedPhase[];
  requestBytes: string[];
  replyBytes: string[];
  acceptances: ExpressionOwnerReplyAcceptance[];
  mutationStates: CellSourceMutationState[];
  editSnapshots: ExpressionEditSnapshot[];
  writeAttempts: number;
  acceptedDurableWrites: number;
  appliedReplyCount: number;
  duplicateReplyCount: number;
}

interface MatrixOwner extends VisualDatabaseEvaluatorDescriptor {
  authoring: VisualDatabaseExpressionAuthoringDescriptor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Expression hostile matrix requires ${label}.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Expression hostile matrix requires ${label} string values.`);
  }
  return [...value];
}

function isOperation(value: string): value is ExpressionOwnerOperation {
  return value === 'analyze'
    || value === 'evaluate'
    || value === 'capabilities'
    || value === 'project_source';
}

function isGuardDimension(value: string): value is ExpressionGuardDimension {
  return (GUARD_DIMENSIONS as readonly string[]).includes(value);
}

function decodeLifecycleEvent(raw: unknown): ExpressionLifecycleProgramEvent {
  if (!isRecord(raw)) throw new Error('Expression hostile lifecycle event must be an object.');
  const type = nonEmpty(raw.type, 'a lifecycle event type');
  if (type === 'request' || type === 'decode_reply' || type === 'reduce_reply' || type === 'cancel'
    || type === 'timeout' || type === 'late_reply' || type === 'undo' || type === 'redo') {
    return { type };
  }
  if (type === 'set_writable') {
    if (typeof raw.value !== 'boolean') throw new Error('set_writable requires a boolean value.');
    return { type, value: raw.value };
  }
  if (type === 'edit_source') return { type, suffix: nonEmpty(raw.suffix, 'an edit suffix') };
  if (type === 'change_guard') {
    const dimension = nonEmpty(raw.dimension, 'a guard dimension');
    if (!isGuardDimension(dimension)) throw new Error(`Unknown guard dimension ${dimension}.`);
    return { type, dimension };
  }
  if (type === 'edit') {
    const operation = nonEmpty(raw.operation, 'an edit operation');
    if (operation !== 'pick' && operation !== 'replace') {
      throw new Error(`Unknown expression edit operation ${operation}.`);
    }
    return {
      type,
      operation,
      references: stringArray(raw.references, 'edit references'),
      ...(raw.selection_reference === undefined
        ? {}
        : { selectionReference: nonEmpty(raw.selection_reference, 'a selected reference') }),
    };
  }
  if (type === 'save') {
    const transport = nonEmpty(raw.transport, 'a save transport');
    const readback = nonEmpty(raw.readback, 'a save readback');
    const feed = nonEmpty(raw.feed, 'a save feed');
    if (transport !== 'accept' && transport !== 'reject' && transport !== 'commit_then_throw') {
      throw new Error(`Unknown save transport ${transport}.`);
    }
    if (readback !== 'match' && readback !== 'conflict' && readback !== 'same_basis' && readback !== 'error') {
      throw new Error(`Unknown save readback ${readback}.`);
    }
    if (feed !== 'match' && feed !== 'missing') throw new Error(`Unknown save feed ${feed}.`);
    return { type, transport, readback, feed };
  }
  throw new Error(`Unknown expression hostile lifecycle event ${type}.`);
}

/** Decodes input-only hostile DATA.  Outcome/terminal/write-count members are
 * rejected so a fixture cannot smuggle its own answer into the report. */
export function decodeExpressionHostileMatrixProgram(
  raw: unknown,
): ExpressionHostileMatrixProgram {
  if (!isRecord(raw) || raw.schema !== 'visual-database.expression-hostile-matrix/v2') {
    throw new Error('Expression hostile matrix has an unsupported schema.');
  }
  for (const forbidden of [
    'expected_rows',
    'expected_outcomes',
    'accepted',
    'terminal_state',
    'durable_write_count',
  ]) if (OWN.call(raw, forbidden)) {
    throw new Error(`Expression hostile matrix input cannot declare ${forbidden}.`);
  }
  const operations = stringArray(raw.operations, 'operations');
  if (operations.some((operation) => !isOperation(operation))) {
    throw new Error('Expression hostile matrix contains an unknown owner operation.');
  }
  const guardDimensions = stringArray(raw.guard_dimensions, 'guard dimensions');
  if (guardDimensions.some((dimension) => !isGuardDimension(dimension))) {
    throw new Error('Expression hostile matrix contains an unknown guard dimension.');
  }
  if (new Set(operations).size !== operations.length
    || new Set(guardDimensions).size !== guardDimensions.length) {
    throw new Error('Expression hostile matrix dimensions must be unique.');
  }
  if (!Array.isArray(raw.lifecycle_programs) || raw.lifecycle_programs.length === 0) {
    throw new Error('Expression hostile matrix requires lifecycle programs.');
  }
  const lifecyclePrograms = raw.lifecycle_programs.map((entry): ExpressionLifecycleProgram => {
    if (!isRecord(entry) || !Array.isArray(entry.events) || entry.events.length === 0) {
      throw new Error('Expression hostile lifecycle program is incomplete.');
    }
    for (const forbidden of ['accepted', 'terminal_state', 'durable_write_count']) {
      if (OWN.call(entry, forbidden)) {
        throw new Error(`Expression hostile lifecycle input cannot declare ${forbidden}.`);
      }
    }
    return {
      id: nonEmpty(entry.id, 'a lifecycle id'),
      events: entry.events.map(decodeLifecycleEvent),
    };
  });
  if (new Set(lifecyclePrograms.map(({ id }) => id)).size !== lifecyclePrograms.length) {
    throw new Error('Expression hostile lifecycle ids must be unique.');
  }
  if (!isRecord(raw.references) || Object.keys(raw.references).length === 0) {
    throw new Error('Expression hostile matrix requires reference DATA.');
  }
  const references = Object.fromEntries(Object.entries(raw.references).map(([key, entry]) => {
    if (!isRecord(entry)) throw new Error(`Expression reference ${key} must be an object.`);
    return [key, {
      id: nonEmpty(entry.id, `reference ${key} id`),
      alias: nonEmpty(entry.alias, `reference ${key} alias`),
    }];
  }));
  return {
    schema: raw.schema,
    operations: operations as ExpressionOwnerOperation[],
    guardDimensions: guardDimensions as ExpressionGuardDimension[],
    lifecyclePrograms,
    references,
  };
}

function changedRevision(value: string | null): string {
  return `${value ?? 'none'}::changed`;
}

export function createExpressionAuthoringSession(
  owner: MatrixOwner,
  writable = true,
): ExpressionAuthoringSession {
  const source = owner.authoring.sourcePrefix;
  return {
    phase: 'editing',
    edit: { source, selection: [source.length, source.length], referenceIds: [] },
    writable,
    history: [],
    future: [],
    evaluationPending: false,
  };
}

function updatePhase(
  state: ExpressionAuthoringSession,
  phase: ExpressionAuthoringPhase,
): ExpressionAuthoringSession {
  return { ...state, phase };
}

/** Edit/save state only. Owner request/reply/cancellation/timeout/revision
 * lifecycle belongs exclusively to ExpressionOwnerSession. */
export function reduceExpressionAuthoringSession(
  state: ExpressionAuthoringSession,
  event: ExpressionAuthoringEvent,
): ExpressionAuthoringSession {
  if (event.type === 'set_writable') return { ...state, writable: event.writable };
  if (event.type === 'source_edited') {
    return {
      ...state,
      phase: 'editing',
      edit: {
        ...state.edit,
        source: event.source,
        selection: event.selection,
      },
    };
  }
  if (event.type === 'save_started') {
    return updatePhase(state, state.writable ? 'saving' : 'read_only');
  }
  if (event.type === 'save_settled') return updatePhase(state, event.state);
  if (event.type === 'guard_changed') {
    if ((event.dimension === 'descriptor_revision' || event.dimension === 'policy_revision')
      && state.phase === 'saved') {
      return {
        ...state,
        phase: 'source_saved_evaluation_pending',
        evaluationPending: true,
      };
    }
    return {
      ...state,
      phase: 'draft_reanalysis_required',
    };
  }
  if (event.type === 'edit_committed') {
    return {
      ...state,
      phase: 'editing',
      edit: event.transaction.after,
      history: [...state.history, event.transaction],
      future: [],
    };
  }
  if (event.type === 'undo') {
    const transaction = state.history[state.history.length - 1];
    if (!transaction) return state;
    return {
      ...state,
      phase: 'editing',
      edit: transaction.before,
      history: state.history.slice(0, -1),
      future: [...state.future, transaction],
    };
  }
  const transaction = state.future[state.future.length - 1];
  if (!transaction) return state;
  return {
    ...state,
    phase: 'editing',
    edit: transaction.after,
    history: [...state.history, transaction],
    future: state.future.slice(0, -1),
  };
}

function uniqueReferences(
  references: readonly ExpressionReferenceInput[],
  deduplicate: boolean,
): ExpressionReferenceInput[] {
  if (!deduplicate) return [...references];
  const seen = new Set<string>();
  return references.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function insertionFor(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  snapshot: ExpressionEditSnapshot,
  references: readonly ExpressionReferenceInput[],
  operation: Extract<ExpressionEditOperation, 'pick' | 'replace'>,
): string {
  const serialized = uniqueReferences(references, descriptor.selectionPolicy.deduplicate)
    .map(({ alias }) => alias)
    .join(descriptor.selectionPolicy.separator);
  if (operation === 'replace') return serialized;
  const [start, end] = snapshot.selection;
  const collapsedAtEnd = start === end && end === snapshot.source.length;
  const hasAuthoredBody = snapshot.source.slice(descriptor.sourcePrefix.length).length > 0;
  return collapsedAtEnd && hasAuthoredBody
    ? `${descriptor.selectionPolicy.separator}${serialized}`
    : serialized;
}

/** Direct manipulation is one reversible transaction over controlled
 * source/selection state.  The descriptor supplies prefix, separator, and
 * deduplication behavior. */
export function applyExpressionReferenceEdit(
  state: ExpressionAuthoringSession,
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  operation: Extract<ExpressionEditOperation, 'pick' | 'replace'>,
  references: readonly ExpressionReferenceInput[],
  transactionId: string,
  replacedReferenceIds: readonly string[] = [],
): ExpressionAuthoringSession {
  if (references.length === 0) return state;
  const [start, end] = state.edit.selection;
  if (start < 0 || end < start || end > state.edit.source.length) {
    throw new Error('Expression reference edit selection is out of bounds.');
  }
  const insertion = insertionFor(descriptor, state.edit, references, operation);
  const source = `${state.edit.source.slice(0, start)}${insertion}${state.edit.source.slice(end)}`;
  const caret = start + insertion.length;
  const deduplicated = uniqueReferences(references, descriptor.selectionPolicy.deduplicate);
  const transaction: ExpressionEditTransaction = {
    id: transactionId,
    before: state.edit,
    after: {
      source,
      selection: [caret, caret],
      referenceIds: [
        ...state.edit.referenceIds.filter((id) => (
          operation !== 'replace' || !replacedReferenceIds.includes(id)
        )),
        ...deduplicated.map(({ id }) => id).filter((id) => !state.edit.referenceIds.includes(id)),
      ],
    },
  };
  return reduceExpressionAuthoringSession(state, { type: 'edit_committed', transaction });
}

function readPath(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!isRecord(current) || !OWN.call(current, segment)) {
      throw new Error(`Expression owner request omitted ${path.join('.')}.`);
    }
    current = current[segment];
  }
  return current;
}

function writePath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const existing = current[segment];
    if (existing === undefined) current[segment] = {};
    else if (!isRecord(existing)) {
      throw new Error(`Expression owner reply path ${path.join('.')} is obstructed.`);
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

function replyDefault(
  key: ExpressionReplySemanticKey,
  operation: ExpressionOwnerOperation,
  request: Readonly<Partial<Record<ExpressionRequestSemanticKey, unknown>>>,
): unknown {
  if (key === 'operation') return operation;
  if (key === 'request_token') return request.request_token;
  if (key === 'source_revision') return request.source_revision;
  if (key === 'catalog_revision') return request.catalog_revision;
  if (key === 'registry_revision') return request.registry_revision ?? 'registry::1';
  if (key === 'policy_revision') return request.expected_policy_revision ?? 'policy::1';
  if (key === 'source' || key === 'canonical_source') return request.source ?? null;
  if (key === 'completion') {
    return { state: 'empty', replacement_span: { start_utf16: 0, end_utf16: 0 }, active_argument: null, items: [] };
  }
  if (key === 'static_dependencies' || key === 'diagnostics' || key === 'functions') return [];
  if (key === 'evaluation_result') return 2;
  if (key === 'evaluation_readset') return { A1: 2 };
  return { state: 'available', source: request.source ?? null };
}

function ownerReply(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
  operation: ExpressionOwnerOperation,
  request: Readonly<Record<string, unknown>>,
  changes: ReadonlySet<ExpressionGuardDimension>,
): Record<string, unknown> {
  const semanticRequest: Partial<Record<ExpressionRequestSemanticKey, unknown>> = {};
  for (const key of descriptor.operations[
    operation === 'project_source' ? 'projectSource' : operation
  ].requiredRequestKeys) {
    semanticRequest[key] = readPath(request, descriptor.requestPaths[key]);
  }
  const reply: Record<string, unknown> = {};
  const required = descriptor.operations[
    operation === 'project_source' ? 'projectSource' : operation
  ].requiredReplyKeys;
  for (const key of required) {
    let value = replyDefault(key, operation, semanticRequest);
    const changeKey = key === 'policy_revision' ? 'policy_revision' : key;
    if (isGuardDimension(changeKey) && changes.has(changeKey)) {
      value = changedRevision(typeof value === 'string' ? value : null);
    }
    writePath(reply, descriptor.replyPaths[key], value);
  }
  return reply;
}

interface DeferredOwnerDispatch {
  target: string;
  request: Record<string, unknown>;
  resolve: (reply: unknown) => void;
  reject: (error: unknown) => void;
  deliveryCount: number;
}

interface ProductionOwnerHarness {
  input: ExpressionOwnerSessionInput;
  session: ExpressionOwnerSession;
  pending: DeferredOwnerDispatch[];
}

function cloneAuthoringDescriptor(
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
): VisualDatabaseExpressionAuthoringDescriptor {
  return JSON.parse(JSON.stringify(descriptor)) as VisualDatabaseExpressionAuthoringDescriptor;
}

function createProductionOwnerHarness(
  owner: MatrixOwner,
  effects: RowEffects,
): ProductionOwnerHarness {
  const pending: DeferredOwnerDispatch[] = [];
  const input: ExpressionOwnerSessionInput = {
    target: owner.target,
    descriptor: cloneAuthoringDescriptor(owner.authoring),
    sourceRevision: 'source::1',
    catalogRevision: 'catalog::1',
  };
  const factory = new ExpressionOwnerSessionFactory((target, request) => {
    effects.requestBytes.push(canonicalExpressionOwnerJson(request));
    return new Promise((resolve, reject) => {
      pending.push({ target, request, resolve, reject, deliveryCount: 0 });
    });
  });
  return { input, session: factory.create(input), pending };
}

async function pendingDispatch(
  harness: ProductionOwnerHarness,
  index = 0,
): Promise<DeferredOwnerDispatch> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dispatch = harness.pending[index];
    if (dispatch) return dispatch;
    await Promise.resolve();
  }
  throw new Error('Production expression owner session did not dispatch the expected request.');
}

function deliverOwnerReply(
  owner: MatrixOwner,
  effects: RowEffects,
  dispatch: DeferredOwnerDispatch,
  operation: ExpressionOwnerOperation,
  changes: ReadonlySet<ExpressionGuardDimension> = new Set(),
): Record<string, unknown> {
  const reply = ownerReply(
    owner.authoring,
    operation,
    dispatch.request,
    changes,
  );
  dispatch.deliveryCount += 1;
  effects.replyBytes.push(canonicalExpressionOwnerJson(reply));
  dispatch.resolve(reply);
  return reply;
}

function invokeProductionOwner(
  session: ExpressionOwnerSession,
  operation: ExpressionOwnerOperation,
  descriptor: VisualDatabaseExpressionAuthoringDescriptor,
): Promise<unknown> {
  if (operation === 'capabilities') return session.capabilities();
  const values = {
    source: `${descriptor.sourcePrefix}A1`,
    cursor_offset_utf16: descriptor.sourcePrefix.length + 2,
    variables: { A1: 2 },
    legacy_request: { binding: { op: 'literal', value: 2 } },
  };
  if (operation === 'analyze') return session.analyze(values);
  if (operation === 'evaluate') return session.evaluate(values);
  return session.projectSource(values);
}

function observeOwnerPhase(
  effects: RowEffects,
  phase: ExpressionObservedPhase,
): void {
  if (effects.transitions.at(-1) !== phase) effects.transitions.push(phase);
}

function rejectionReason(error: unknown): string {
  if (error instanceof ExpressionOwnerReplyRejectedError) return error.reason;
  if (error instanceof ExpressionOwnerStaleReplyError) return 'stale';
  if (error instanceof Error && error.message.includes('did not reply within')) return 'timeout';
  return error instanceof Error ? error.message : String(error);
}

async function observeProductionOwnerResult(
  promise: Promise<unknown>,
  effects: RowEffects,
  acceptedPhase: ExpressionObservedPhase = 'accepted',
): Promise<boolean> {
  try {
    await promise;
    effects.acceptances.push({ accepted: true });
    effects.appliedReplyCount += 1;
    observeOwnerPhase(effects, acceptedPhase);
    return true;
  } catch (error) {
    const reason = rejectionReason(error);
    const protocolReason = (
      reason === 'target'
      || reason === 'descriptor_revision'
      || reason === 'request_token'
      || reason === 'source_revision'
      || reason === 'catalog_revision'
      || reason === 'registry_revision'
      || reason === 'policy_revision'
        ? reason
        : undefined
    );
    effects.acceptances.push({
      accepted: false,
      ...(protocolReason ? { reason: protocolReason } : {}),
    });
    observeOwnerPhase(
      effects,
      reason === 'timeout' ? 'timed_out' : 'discarded_stale',
    );
    return false;
  }
}

function observe(
  state: ExpressionAuthoringSession,
  effects: RowEffects,
  next: ExpressionAuthoringSession,
): ExpressionAuthoringSession {
  if (next.phase !== state.phase || effects.transitions.length === 0) {
    effects.transitions.push(next.phase);
  }
  if (canonicalExpressionOwnerJson(next.edit) !== canonicalExpressionOwnerJson(state.edit)) {
    effects.editSnapshots.push(next.edit);
  }
  return next;
}

function reduceObserved(
  state: ExpressionAuthoringSession,
  effects: RowEffects,
  event: ExpressionAuthoringEvent,
): ExpressionAuthoringSession {
  return observe(state, effects, reduceExpressionAuthoringSession(state, event));
}

function emptyEffects(): RowEffects {
  return {
    transitions: [],
    requestBytes: [],
    replyBytes: [],
    acceptances: [],
    mutationStates: [],
    editSnapshots: [],
    writeAttempts: 0,
    acceptedDurableWrites: 0,
    appliedReplyCount: 0,
    duplicateReplyCount: 0,
  };
}

function observedRow(
  id: string,
  category: ExpressionObservedRow['category'],
  owner: MatrixOwner,
  state: ExpressionAuthoringSession,
  effects: RowEffects,
  input: {
    operation?: ExpressionOwnerOperation;
    pairedOperation?: ExpressionOwnerOperation | ExpressionEditOperation;
    changed?: readonly string[];
  } = {},
): ExpressionObservedRow {
  return {
    id,
    category,
    ownerRef: owner.ref,
    ...(input.operation ? { operation: input.operation } : {}),
    ...(input.pairedOperation ? { pairedOperation: input.pairedOperation } : {}),
    changed: input.changed ?? [],
    requestBytes: effects.requestBytes,
    replyBytes: effects.replyBytes,
    ownerAcceptances: effects.acceptances,
    transitions: effects.transitions,
    terminalState: effects.transitions.at(-1) ?? state.phase,
    writeAttempts: effects.writeAttempts,
    acceptedDurableWrites: effects.acceptedDurableWrites,
    appliedReplyCount: effects.appliedReplyCount,
    duplicateReplyCount: effects.duplicateReplyCount,
    mutationStates: effects.mutationStates,
    editSnapshots: effects.editSnapshots,
    edit: state.edit,
    historyDepth: state.history.length,
    redoDepth: state.future.length,
  };
}

function subsets<T>(values: readonly T[]): T[][] {
  const output: T[][] = [];
  for (let mask = 1; mask < 2 ** values.length; mask += 1) {
    output.push(values.filter((_value, index) => (mask & (1 << index)) !== 0));
  }
  return output;
}

async function executeGuardRow(
  owner: MatrixOwner,
  operation: ExpressionOwnerOperation,
  changed: readonly ExpressionGuardDimension[],
  targetChanged: boolean,
): Promise<ExpressionObservedRow> {
  const effects = emptyEffects();
  const state = createExpressionAuthoringSession(owner);
  const harness = createProductionOwnerHarness(owner, effects);
  observeOwnerPhase(effects, 'awaiting_owner');
  const result = invokeProductionOwner(harness.session, operation, harness.input.descriptor);
  let dispatchIndex = 0;

  if (operation !== 'capabilities') {
    const bootstrap = await pendingDispatch(harness, dispatchIndex);
    deliverOwnerReply(owner, effects, bootstrap, 'capabilities');
    dispatchIndex += 1;
  }

  const operationDispatch = await pendingDispatch(harness, dispatchIndex);
  if (targetChanged) harness.input.target = changedRevision(harness.input.target);
  if (changed.includes('descriptor_revision')) {
    harness.input.descriptor.revision = changedRevision(harness.input.descriptor.revision);
  }
  const replyChanges = new Set(changed.filter((dimension) => dimension !== 'descriptor_revision'));
  deliverOwnerReply(owner, effects, operationDispatch, operation, replyChanges);

  const rejectionOrder = [
    ...(targetChanged ? ['target'] as const : []),
    ...changed,
  ];
  const firstNonRefreshGuard = rejectionOrder.find((dimension) => (
    dimension !== 'registry_revision' && dimension !== 'policy_revision'
  ));
  const refreshesOwner = operation !== 'capabilities'
    && !firstNonRefreshGuard
    && (changed.includes('registry_revision') || changed.includes('policy_revision'));
  if (refreshesOwner) {
    dispatchIndex += 1;
    const refresh = await pendingDispatch(harness, dispatchIndex);
    deliverOwnerReply(owner, effects, refresh, 'capabilities', replyChanges);
    dispatchIndex += 1;
    const retry = await pendingDispatch(harness, dispatchIndex);
    deliverOwnerReply(owner, effects, retry, operation);
  }

  await observeProductionOwnerResult(
    result,
    effects,
    refreshesOwner || (
      operation === 'capabilities'
      && (changed.includes('registry_revision') || changed.includes('policy_revision'))
    )
      ? 'catalog_replaced'
      : 'accepted',
  );
  harness.session.close();
  const allChanged = [...(targetChanged ? ['target'] : []), ...changed];
  return observedRow(
    `${operation}:${owner.ref}:${allChanged.length ? allChanged.join('+') : 'match'}`,
    'guard',
    owner,
    state,
    effects,
    { operation, changed: allChanged },
  );
}

function matchingSourceRow(
  expression: VisualDatabaseValueExpression,
  sourceRevision: string,
  basis: number,
): AddressedCellValueRecord {
  return {
    payload: {
      cell_ref: { record_ref: 'record::hostile', field_ref: 'field::hostile' },
      expression: visualDatabaseValueExpressionPayload(expression),
      revision: sourceRevision,
    },
    expectedCurrent: { payloadHash: new Uint8Array([basis]) },
  };
}

async function executeSave(
  owner: MatrixOwner,
  state: ExpressionAuthoringSession,
  effects: RowEffects,
  event: Extract<ExpressionLifecycleProgramEvent, { type: 'save' }>,
  settlementPolicy: MutationSettlementPolicy,
): Promise<ExpressionAuthoringSession> {
  let next = reduceObserved(state, effects, { type: 'save_started' });
  if (!next.writable) return next;
  const durableRequest = buildDurableExpressionOwnerRequest(
    owner.authoring,
    next.edit.source,
  );
  const expression: VisualDatabaseValueExpression = {
    derive: {
      target: owner.target,
      evaluatorRef: owner.ref,
      request: durableRequest,
    },
  };
  const draft = createCellSourceMutationDraft({
    cellRef: { recordRef: 'record::hostile', fieldRef: 'field::hostile' },
    expression,
    sourceExpectedCurrent: { payloadHash: new Uint8Array([1]) },
    allocateRevision: () => 'source::saved',
  });
  const matching = matchingSourceRow(expression, draft.sourceRevision, 2);
  const conflict = matchingSourceRow({ literal: 99 }, 'source::other', 9);
  const sameBasis = matchingSourceRow({ literal: 1 }, 'source::prior', 1);
  let writeAttempted = false;
  let clockNow = 0;
  const coordinator = new MutationSettlementCoordinator({
    now: () => clockNow,
    wait: async (milliseconds) => { clockNow += milliseconds; },
  });
  effects.mutationStates.push('saving');
  const settlement = await coordinator.settle(buildCellSourceSettlementAttempt(draft, {
    write: async () => {
      writeAttempted = true;
      effects.writeAttempts += 1;
      if (event.transport === 'reject') throw new Error('write rejected');
      effects.acceptedDurableWrites += 1;
      if (event.transport === 'commit_then_throw') throw new Error('reply lost after commit');
    },
    read: async () => {
      if (!writeAttempted) return sameBasis;
      if (event.readback === 'error') throw new Error('readback unavailable');
      if (event.readback === 'conflict') return conflict;
      if (event.readback === 'same_basis') return sameBasis;
      return matching;
    },
    waitForFeed: async () => writeAttempted && event.feed === 'match' ? matching : null,
  }, {
    attemptId: `matrix-source:${owner.ref}:${draft.sourceRevision}`,
    policy: settlementPolicy,
  }));
  effects.mutationStates.push('awaiting-readback');
  const settledState: CellSourceMutationResult['state'] = settlement.state === 'timeout'
    || settlement.state === 'stale'
    ? 'unknown'
    : settlement.state;
  effects.mutationStates.push(settledState);
  next = reduceObserved(next, effects, { type: 'save_settled', state: settledState });
  return next;
}

function referenceInputs(
  program: ExpressionHostileMatrixProgram,
  keys: readonly string[],
): ExpressionReferenceInput[] {
  return keys.map((key) => {
    const reference = program.references[key];
    if (!reference) throw new Error(`Expression hostile matrix has no reference ${key}.`);
    return reference;
  });
}

async function executeLifecycleRow(
  program: ExpressionHostileMatrixProgram,
  lifecycle: ExpressionLifecycleProgram,
  owner: MatrixOwner,
  operation: ExpressionOwnerOperation,
  settlementPolicy: MutationSettlementPolicy,
): Promise<ExpressionObservedRow> {
  const effects = emptyEffects();
  let state = createExpressionAuthoringSession(owner);
  const harness = createProductionOwnerHarness(owner, effects);
  let dispatchIndex = 0;
  let activePromise: Promise<unknown> | null = null;
  let activeDispatch: DeferredOwnerDispatch | null = null;
  let activeObserved = false;
  let replacementPromise: Promise<unknown> | null = null;
  let replacementDispatch: DeferredOwnerDispatch | null = null;
  let transactionSequence = 0;

  if (operation !== 'capabilities') {
    const warm = harness.session.capabilities();
    const bootstrap = await pendingDispatch(harness, dispatchIndex);
    deliverOwnerReply(owner, effects, bootstrap, 'capabilities');
    await warm;
    dispatchIndex += 1;
    effects.requestBytes.length = 0;
    effects.replyBytes.length = 0;
  }

  for (const event of lifecycle.events) {
    if (event.type === 'request') {
      observeOwnerPhase(effects, 'awaiting_owner');
      activePromise = invokeProductionOwner(
        harness.session,
        operation,
        harness.input.descriptor,
      );
      activeDispatch = await pendingDispatch(harness, dispatchIndex);
      dispatchIndex += 1;
      activeObserved = false;
    } else if (event.type === 'decode_reply') {
      if (!activeDispatch) {
        throw new Error(`Lifecycle ${lifecycle.id} decoded a reply before request.`);
      }
      if (activeDispatch.deliveryCount === 0) {
        deliverOwnerReply(owner, effects, activeDispatch, operation);
      }
    } else if (event.type === 'reduce_reply') {
      if (!activePromise || !activeDispatch) {
        throw new Error(`Lifecycle ${lifecycle.id} reduced a reply before request.`);
      }
      if (activeObserved) {
        deliverOwnerReply(owner, effects, activeDispatch, operation);
        effects.duplicateReplyCount += 1;
        observeOwnerPhase(effects, 'duplicate_ignored');
      } else {
        if (activeDispatch.deliveryCount === 0) {
          throw new Error(`Lifecycle ${lifecycle.id} reduced a reply before delivery.`);
        }
        await observeProductionOwnerResult(activePromise, effects);
        activeObserved = true;
      }
    } else if (event.type === 'cancel') {
      harness.session.cancelPending();
      observeOwnerPhase(effects, 'cancelled');
    } else if (event.type === 'timeout') {
      if (!activePromise) throw new Error(`Lifecycle ${lifecycle.id} timed out before request.`);
      await observeProductionOwnerResult(activePromise, effects);
      activeObserved = true;
    } else if (event.type === 'late_reply') {
      if (!activePromise || !activeDispatch) {
        throw new Error(`Lifecycle ${lifecycle.id} received a late reply before request.`);
      }
      if (replacementPromise && replacementDispatch) {
        if (replacementDispatch.deliveryCount === 0) {
          deliverOwnerReply(owner, effects, replacementDispatch, operation);
        }
        if (activeDispatch.deliveryCount === 0) {
          deliverOwnerReply(owner, effects, activeDispatch, operation);
        }
        if (!activeObserved) {
          await observeProductionOwnerResult(activePromise, effects);
          activeObserved = true;
        }
        await observeProductionOwnerResult(replacementPromise, effects);
      } else {
        if (activeDispatch.deliveryCount === 0) {
          deliverOwnerReply(owner, effects, activeDispatch, operation);
        }
        if (!activeObserved) {
          await observeProductionOwnerResult(activePromise, effects);
          activeObserved = true;
        } else {
          observeOwnerPhase(effects, 'discarded_stale');
        }
      }
    } else if (event.type === 'set_writable') {
      state = reduceObserved(state, effects, { type: 'set_writable', writable: event.value });
    } else if (event.type === 'edit_source') {
      harness.session.cancelPending();
      const source = `${state.edit.source}${event.suffix}`;
      state = reduceObserved(state, effects, {
        type: 'source_edited',
        source,
        selection: [source.length, source.length],
      });
      if (activePromise) {
        replacementPromise = invokeProductionOwner(
          harness.session,
          operation,
          harness.input.descriptor,
        );
        if (operation === 'capabilities') {
          replacementDispatch = activeDispatch;
        } else {
          replacementDispatch = await pendingDispatch(harness, dispatchIndex);
          dispatchIndex += 1;
        }
      }
    } else if (event.type === 'save') {
      state = await executeSave(owner, state, effects, event, settlementPolicy);
    } else if (event.type === 'change_guard') {
      harness.session.cancelPending();
      state = reduceObserved(state, effects, {
        type: 'guard_changed',
        dimension: event.dimension,
      });
    } else if (event.type === 'edit') {
      transactionSequence += 1;
      let replacedReferenceIds: readonly string[] = [];
      if (event.operation === 'replace' && event.selectionReference) {
        const selected = program.references[event.selectionReference];
        if (!selected) {
          throw new Error(`Expression hostile matrix has no reference ${event.selectionReference}.`);
        }
        const start = state.edit.source.indexOf(selected.alias);
        if (start < 0) {
          throw new Error(`Expression edit cannot select absent reference ${event.selectionReference}.`);
        }
        state = {
          ...state,
          edit: {
            ...state.edit,
            selection: [start, start + selected.alias.length],
          },
        };
        replacedReferenceIds = [selected.id];
      }
      state = observe(state, effects, applyExpressionReferenceEdit(
        state,
        owner.authoring,
        event.operation,
        referenceInputs(program, event.references),
        `${lifecycle.id}::${transactionSequence}`,
        replacedReferenceIds,
      ));
    } else {
      state = reduceObserved(state, effects, { type: event.type });
    }
  }
  harness.session.close();

  return observedRow(
    `${operation}:${owner.ref}:lifecycle:${lifecycle.id}`,
    'lifecycle',
    owner,
    state,
    effects,
    { operation, changed: lifecycle.events.map(({ type }) => type) },
  );
}

async function executeOwnerSelfComposition(
  owner: MatrixOwner,
  first: ExpressionOwnerOperation,
  second: ExpressionOwnerOperation,
): Promise<ExpressionObservedRow> {
  const effects = emptyEffects();
  const state = createExpressionAuthoringSession(owner);
  const harness = createProductionOwnerHarness(owner, effects);
  let dispatchIndex = 0;
  for (const operation of [first, second]) {
    const hadCapabilities = harness.session.revisions() !== null;
    observeOwnerPhase(effects, 'awaiting_owner');
    const result = invokeProductionOwner(
      harness.session,
      operation,
      harness.input.descriptor,
    );
    if (!hadCapabilities) {
      const bootstrap = await pendingDispatch(harness, dispatchIndex);
      deliverOwnerReply(owner, effects, bootstrap, 'capabilities');
      dispatchIndex += 1;
    }
    if (operation !== 'capabilities') {
      const dispatch = await pendingDispatch(harness, dispatchIndex);
      deliverOwnerReply(owner, effects, dispatch, operation);
      dispatchIndex += 1;
    }
    await observeProductionOwnerResult(result, effects);
  }
  harness.session.close();
  return observedRow(
    `${owner.ref}:compose:${first}:${second}`,
    'owner_self_composition',
    owner,
    state,
    effects,
    { operation: first, pairedOperation: second, changed: [first, second] },
  );
}

function operationReference(
  program: ExpressionHostileMatrixProgram,
  operation: Extract<ExpressionEditOperation, 'pick' | 'replace'>,
): ExpressionReferenceInput[] {
  const keys = Object.keys(program.references);
  return referenceInputs(program, operation === 'pick' ? keys.slice(0, 1) : keys.slice(1, 2));
}

function prepareEditCompositionState(
  owner: MatrixOwner,
  program: ExpressionHostileMatrixProgram,
): ExpressionAuthoringSession {
  let state = createExpressionAuthoringSession(owner);
  state = applyExpressionReferenceEdit(
    state,
    owner.authoring,
    'pick',
    referenceInputs(program, Object.keys(program.references).slice(0, 2)),
    'prepare::pick',
  );
  const secondAlias = Object.keys(program.references)[1]!;
  const alias = program.references[secondAlias]!.alias;
  const start = state.edit.source.indexOf(alias);
  state = {
    ...state,
    edit: { ...state.edit, selection: [start, start + alias.length] },
  };
  state = applyExpressionReferenceEdit(
    state,
    owner.authoring,
    'replace',
    referenceInputs(program, Object.keys(program.references).slice(2, 3)),
    'prepare::replace',
    [program.references[secondAlias]!.id],
  );
  return reduceExpressionAuthoringSession(state, { type: 'undo' });
}

function applyEditOperation(
  state: ExpressionAuthoringSession,
  owner: MatrixOwner,
  program: ExpressionHostileMatrixProgram,
  operation: ExpressionEditOperation,
  id: string,
): ExpressionAuthoringSession {
  if (operation === 'undo' || operation === 'redo') {
    return reduceExpressionAuthoringSession(state, { type: operation });
  }
  const references = operationReference(program, operation);
  let positioned = state;
  let replacedReferenceIds: readonly string[] = [];
  if (operation === 'replace') {
    const alias = references[0]!.alias;
    const candidate = Object.values(program.references).find(({ alias: current }) => (
      positioned.edit.source.includes(current) && current !== alias
    ));
    if (!candidate) return positioned;
    const start = positioned.edit.source.indexOf(candidate.alias);
    positioned = {
      ...positioned,
      edit: { ...positioned.edit, selection: [start, start + candidate.alias.length] },
    };
    replacedReferenceIds = [candidate.id];
  } else {
    const end = positioned.edit.source.length;
    positioned = {
      ...positioned,
      edit: { ...positioned.edit, selection: [end, end] },
    };
  }
  return applyExpressionReferenceEdit(
    positioned,
    owner.authoring,
    operation,
    references,
    id,
    replacedReferenceIds,
  );
}

function executeEditSelfComposition(
  owner: MatrixOwner,
  program: ExpressionHostileMatrixProgram,
  first: ExpressionEditOperation,
  second: ExpressionEditOperation,
): ExpressionObservedRow {
  const effects = emptyEffects();
  let state = prepareEditCompositionState(owner, program);
  const next = applyEditOperation(state, owner, program, first, `compose::${first}`);
  state = observe(state, effects, next);
  const last = applyEditOperation(state, owner, program, second, `compose::${second}`);
  state = observe(state, effects, last);
  return observedRow(
    `${owner.ref}:edit-compose:${first}:${second}`,
    'edit_self_composition',
    owner,
    state,
    effects,
    { pairedOperation: second, changed: [first, second] },
  );
}

function requireOwners(
  owners: readonly VisualDatabaseEvaluatorDescriptor[],
): MatrixOwner[] {
  if (owners.length < 2) throw new Error('Hostile matrix requires at least two evaluator descriptors.');
  return owners.map((owner) => {
    if (!owner.authoring) throw new Error(`Evaluator ${owner.ref} has no authoring descriptor.`);
    return owner as MatrixOwner;
  });
}

function countBy<T extends string>(
  values: readonly T[],
): Record<T, number> {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

/** Runs the complete adversarial composition space against production
 * operations.  The report is a projection of observed rows only. */
export async function runExpressionAuthoringHostileMatrix(
  program: ExpressionHostileMatrixProgram,
  evaluatorDescriptors: readonly VisualDatabaseEvaluatorDescriptor[],
  settlementPolicy: MutationSettlementPolicy,
): Promise<ExpressionHostileMatrixReport> {
  const owners = requireOwners(evaluatorDescriptors);
  const rows: ExpressionObservedRow[] = [];
  const revisionSubsets = subsets(program.guardDimensions);
  for (const owner of owners) for (const operation of program.operations) {
    rows.push(await executeGuardRow(owner, operation, [], false));
    rows.push(await executeGuardRow(owner, operation, [], true));
    for (const changed of revisionSubsets) {
      rows.push(await executeGuardRow(owner, operation, changed, false));
    }
    for (const lifecycle of program.lifecyclePrograms) {
      rows.push(await executeLifecycleRow(program, lifecycle, owner, operation, settlementPolicy));
    }
    for (const paired of program.operations) {
      rows.push(await executeOwnerSelfComposition(owner, operation, paired));
    }
  }
  for (const owner of owners) for (const operation of EDIT_OPERATIONS) {
    for (const paired of EDIT_OPERATIONS) {
      rows.push(executeEditSelfComposition(owner, program, operation, paired));
    }
  }
  const rowIds = rows.map(({ id }) => id);
  if (new Set(rowIds).size !== rowIds.length) {
    throw new Error('Expression hostile matrix produced duplicate row ids.');
  }
  return {
    schema: 'visual-database.expression-hostile-matrix-report/v2',
    rows,
    rowIds,
    totalCount: rows.length,
    countsByCategory: countBy(rows.map(({ category }) => category)),
    countsByTerminalState: countBy(rows.map(({ terminalState }) => terminalState)),
    totalWriteAttempts: rows.reduce((total, row) => total + row.writeAttempts, 0),
    totalAcceptedDurableWrites: rows.reduce(
      (total, row) => total + row.acceptedDurableWrites,
      0,
    ),
    ownerWireIdentities: Object.fromEntries(owners.map((owner) => [
      owner.ref,
      rows
        .filter((row) => row.ownerRef === owner.ref)
        .flatMap((row) => row.requestBytes)
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort(),
    ])),
  };
}
