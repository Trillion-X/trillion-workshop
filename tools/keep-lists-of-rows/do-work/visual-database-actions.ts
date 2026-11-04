//
// Builds generic Runtime Kit target requests from visual-database action descriptors.
// The board supplies context; the action owner supplies meaning.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import type {
  VisualDatabaseActionDescriptor,
  VisualDatabaseLaneDescriptor,
  VisualDatabaseRecord,
} from '../read-data/visual-database';

export interface VisualDatabaseActionContext {
  record: VisualDatabaseRecord;
  /** Open selection context supplied by any board view.  The first `record`
   * remains the invocation anchor for legacy descriptors; an action that
   * understands a collection receives every exact selected record reference.
   * This is board vocabulary, never a feature-specific input. */
  selectedRecords?: readonly VisualDatabaseRecord[];
  lane?: VisualDatabaseLaneDescriptor;
  /** The reference the action targets (rides under the action's `valueKey`) —
   *  e.g. the assignee option the human picked. The board never knows what it is. */
  value?: string;
  /** Answers to the action's declared input prompts, keyed by prompt key. */
  answers?: Readonly<Record<string, string>>;
}

export interface VisualDatabaseSelectedRecordRef {
  address: string;
  kind?: string;
}

export interface VisualDatabaseActionSource {
  package: 'visual-database';
  surface: 'visual-database';
  descriptor_id: string;
}

export interface VisualDatabaseTargetRequest {
  target: string;
  action: string;
  correlation_id: string;
  payload: Record<string, unknown>;
  source: VisualDatabaseActionSource;
  selected_record_refs: readonly VisualDatabaseSelectedRecordRef[];
}

export type VisualDatabaseTargetSender = (request: VisualDatabaseTargetRequest) => Promise<unknown>;

const UNSAFE_INPUT_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

function checkedPromptInputPath(path: readonly string[] | undefined, key: string): readonly string[] | null {
  if (path === undefined) return null;
  if (!path.length || path.some(part => typeof part !== 'string' || !part || UNSAFE_INPUT_PATH_PARTS.has(part))) {
    throw new TypeError(`Action prompt ${key} has an invalid input_path.`);
  }
  return path;
}

export interface VisualDatabaseDescriptorError {
  code: 'missing-target';
  descriptor_id: string;
  package_id: 'visual-database';
  missing_field: 'target';
  selected_record_refs: readonly VisualDatabaseSelectedRecordRef[];
}

export type VisualDatabaseActionInterpretationResult =
  | { ok: true; requests: readonly VisualDatabaseTargetRequest[]; event: VisualDatabaseActionInterpretationEvent }
  | { ok: false; error: VisualDatabaseDescriptorError; event: VisualDatabaseActionInterpretationEvent };

export interface VisualDatabaseActionInterpretationEvent {
  package: 'visual-database';
  event: 'visual-database.action.interpretation';
  descriptor_id: string;
  target: string | null;
  selected_record_count: number;
  result: 'request' | 'descriptor-error';
  error_code?: VisualDatabaseDescriptorError['code'];
  input_schema_keys: readonly string[];
}

function recordAddress(record: VisualDatabaseRecord): string | null {
  const raw = record.raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const address = (raw as { address?: unknown }).address;
    return typeof address === 'string' && address.length > 0 ? address : null;
  }
  return null;
}

/** Translate the board's local selection into the exact owner-facing address
 *  rows every action family consumes. This is the single Visual Database
 *  selection boundary for descriptor actions and action-affordance records. */
export function visualDatabaseSelectedRecordRefs(
  context: VisualDatabaseActionContext,
): readonly VisualDatabaseSelectedRecordRef[] {
  const records = context.selectedRecords?.length ? context.selectedRecords : [context.record];
  const seen = new Set<string>();
  return records.flatMap((record) => {
    // A selection materializer may only resolve a real Engine address.  The
    // renderer's local id is useful display state, never an address claim.
    const address = recordAddress(record);
    if (!address || seen.has(address)) return [];
    seen.add(address);
    return [{ address, kind: record.kind || undefined }];
  });
}

function inputSchemaKeys(action: VisualDatabaseActionDescriptor): readonly string[] {
  return [
    ...Object.keys(action.input ?? {}),
    ...action.copy.map((entry) => entry.key),
    ...action.generate.map((entry) => entry.key),
    ...action.inputPrompts.map((entry) => entry.key),
    ...(action.valueKey ? [action.valueKey] : []),
  ];
}

function createCorrelationId(action: VisualDatabaseActionDescriptor, record: VisualDatabaseRecord): string {
  return [
    'visual-database-action',
    action.id,
    recordAddress(record) ?? record.id,
  ].join(':');
}

function interpretationEvent(
  action: VisualDatabaseActionDescriptor,
  target: string | null,
  refs: readonly VisualDatabaseSelectedRecordRef[],
  result: 'request' | 'descriptor-error',
  errorCode?: VisualDatabaseDescriptorError['code'],
): VisualDatabaseActionInterpretationEvent {
  return {
    package: 'visual-database',
    event: 'visual-database.action.interpretation',
    descriptor_id: action.id,
    target,
    selected_record_count: refs.length,
    result,
    ...(errorCode ? { error_code: errorCode } : {}),
    input_schema_keys: inputSchemaKeys(action),
  };
}

function emitInterpretationEvent(event: VisualDatabaseActionInterpretationEvent): void {
  const sink = (globalThis as { __visualDatabaseActionEventSink?: (event: VisualDatabaseActionInterpretationEvent) => void })
    .__visualDatabaseActionEventSink;
  if (sink) sink(event);
}

function readCopySource(context: VisualDatabaseActionContext, source: string): unknown {
  const parts = source.split('.').filter(Boolean);
  let current: unknown;
  switch (parts.shift()) {
    case 'answers':
      current = context.answers ?? {};
      break;
    case 'record':
      current = {
        id: context.record.id,
        title: context.record.title,
        kind: context.record.kind,
        group: context.record.group,
        lane_id: context.record.lane.id,
        date: context.record.date,
        address: recordAddress(context.record),
        // The record's own values, as its source carried them, so a row copies exactly the one it names.
        payload: context.record.raw && typeof context.record.raw === 'object' ? (context.record.raw as { payload?: unknown }).payload : undefined,
      };
      break;
    case 'lane':
      current = context.lane ?? null;
      break;
    case 'value':
      current = context.value;
      break;
    default:
      return undefined;
  }
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function buildVisualDatabaseActionInput(
  action: VisualDatabaseActionDescriptor,
  context: VisualDatabaseActionContext,
): Record<string, unknown> {
  const currentSelection = visualDatabaseSelectedRecordRefs(context);
  const requestedValues = action.generate.map((entry) => ({
    key: entry.key,
    method: entry.method,
    params: entry.params,
  }));
  const copied: Record<string, unknown> = {};
  for (const entry of action.copy) {
    const value = entry.from ? readCopySource(context, entry.from) : entry.value;
    if (value !== undefined) copied[entry.key] = value;
  }
  const withPromptAnswers = structuredClone(action.input ?? {}) as Record<string, unknown>;
  for (const prompt of action.inputPrompts) {
    const inputPath = checkedPromptInputPath(prompt.inputPath, prompt.key);
    const answer = context.answers?.[prompt.key];
    if (answer === undefined || answer === '') continue;
    let value: unknown = answer;
    if (prompt.kind === 'number') {
      value = Number(answer);
      if (!Number.isFinite(value)) throw new TypeError(`${prompt.label || prompt.key} must be a valid number.`);
    } else if (prompt.kind === 'boolean') {
      if (answer !== 'true' && answer !== 'false') throw new TypeError(`${prompt.label || prompt.key} must be true or false.`);
      value = answer === 'true';
    }
    if (!inputPath) continue;
    let parent = withPromptAnswers;
    for (const part of inputPath.slice(0, -1)) {
      const current = parent[part];
      if (!current || typeof current !== 'object' || Array.isArray(current)) parent[part] = {};
      parent = parent[part] as Record<string, unknown>;
    }
    parent[inputPath[inputPath.length - 1]] = value;
  }
  return {
    ...withPromptAnswers,
    ...(requestedValues.length > 0 ? { requested_values: requestedValues } : {}),
    ...(context.answers ?? {}),
    ...(action.valueKey && context.value !== undefined ? { [action.valueKey]: context.value } : {}),
    ...copied,
    action_id: action.id,
    action_label: action.label,
    record_id: context.record.id,
    record_title: context.record.title,
    record_kind: context.record.kind,
    current_lane_id: context.record.lane.id,
    target_lane_id: context.lane?.id ?? null,
    // `selection_items` is the open caller-facing transport: address labels
    // only. Owners hydrate revisions/hashes themselves, so the board never
    // fabricates provenance from a rendered row.
    selection_items: currentSelection.map(({ address }) => ({ address })),
    selected_record_refs: currentSelection,
    record: {
      id: context.record.id,
      title: context.record.title,
      kind: context.record.kind,
      group: context.record.group,
      lane_id: context.record.lane.id,
      date: context.record.date,
      address: recordAddress(context.record),
    },
    lane: context.lane
      ? {
          id: context.lane.id,
          label: context.lane.label,
        }
      : null,
  };
}

export function buildVisualDatabaseActionRequests(
  action: VisualDatabaseActionDescriptor,
  context: VisualDatabaseActionContext,
): VisualDatabaseTargetRequest[] {
  const result = interpretVisualDatabaseActionRequests(action, context);
  if (!result.ok) throw Object.assign(new Error(result.error.code), { descriptorError: result.error });
  return [...result.requests];
}

export function interpretVisualDatabaseActionRequests(
  action: VisualDatabaseActionDescriptor,
  context: VisualDatabaseActionContext,
): VisualDatabaseActionInterpretationResult {
  const target = action.target?.trim();
  const refs = visualDatabaseSelectedRecordRefs(context);
  if (!target) {
    const event = interpretationEvent(action, null, refs, 'descriptor-error', 'missing-target');
    emitInterpretationEvent(event);
    return {
      ok: false,
      error: {
        code: 'missing-target',
        descriptor_id: action.id,
        package_id: 'visual-database',
        missing_field: 'target',
        selected_record_refs: refs,
      },
      event,
    };
  }
  const input = buildVisualDatabaseActionInput(action, context);
  const definitionIds = action.definitionIds.length > 0
    ? action.definitionIds
    : action.definitionId ? [action.definitionId] : [];
  const source: VisualDatabaseActionSource = {
    package: 'visual-database',
    surface: 'visual-database',
    descriptor_id: action.id,
  };
  const selected_record_refs = visualDatabaseSelectedRecordRefs(context);
  const correlation_id = createCorrelationId(action, context.record);
  const actionName = definitionIds.length > 0 ? 'execute_definition' : action.operation ?? action.id;
  const event = interpretationEvent(action, target, selected_record_refs, 'request');
  emitInterpretationEvent(event);
  if (definitionIds.length > 0) {
    return {
      ok: true,
      requests: definitionIds.map((definitionId) => ({
        target,
        action: actionName,
        correlation_id,
        payload: {
          operation: 'execute_definition',
          definition_id: definitionId,
          include_steps: false,
          include_output: false,
          input,
        },
        source,
        selected_record_refs,
      })),
      event,
    };
  }
  return {
    ok: true,
    requests: [{
      target,
      action: actionName,
      correlation_id,
      payload: {
        operation: action.operation ?? action.id,
        action_id: action.id,
        input,
      },
      source,
      selected_record_refs,
    }],
    event,
  };
}

export function buildVisualDatabaseActionRequest(
  action: VisualDatabaseActionDescriptor,
  context: VisualDatabaseActionContext,
): VisualDatabaseTargetRequest {
  return buildVisualDatabaseActionRequests(action, context)[0]!;
}

export async function invokeVisualDatabaseAction(
  action: VisualDatabaseActionDescriptor,
  context: VisualDatabaseActionContext,
  sender: VisualDatabaseTargetSender = sendRequestToBitfieldTarget as VisualDatabaseTargetSender,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const request of buildVisualDatabaseActionRequests(action, context)) {
    results.push(await sender(request));
  }
  return results;
}
