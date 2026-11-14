// package-set://bitfield-studio/packages/record-board-progress-feed/read-data/source-correlated-records.ts
//
// Pure source-correlated record projection. This package owns the translation
// from generic source/event/proof/action data into ordinary progress rows; it
// does not own task execution, process sessions, workflow, or board rendering.

export type JsonRecord = Record<string, unknown>;

export interface SourceRecordRef {
  address: string;
  label?: string;
  kind?: string;
  archived?: boolean;
  raw?: unknown;
}

export interface ProgressProofRef {
  id: string;
  label: string;
  address?: string;
  url?: string;
  filePath?: string;
  contentAddress?: string;
  raw?: unknown;
}

export interface SourceCorrelatedEvent {
  id: string;
  source: SourceRecordRef;
  producer: string;
  occurredAtMs: number;
  state: string;
  summary?: string;
  detail?: string;
  proofRefs?: readonly ProgressProofRef[];
  diagnosticRefs?: readonly ProgressDiagnostic[];
  raw?: unknown;
}

export interface ProgressDiagnostic {
  code: string;
  message: string;
  sourceAddress?: string;
  producer?: string;
  eventId?: string;
  severity?: string;
  raw?: unknown;
}

export interface RecordProgressRow {
  id: string;
  source: SourceRecordRef;
  currentState: string;
  summary: string;
  latestEventAtMs: number | null;
  eventCount: number;
  producerRefs: readonly string[];
  proofRefs: readonly ProgressProofRef[];
  diagnosticRefs: readonly ProgressDiagnostic[];
  events: readonly SourceCorrelatedEvent[];
  raw: {
    sourceAddress: string;
    sourceKind?: string;
  };
}

export interface SourceCorrelatedProjection {
  rows: readonly RecordProgressRow[];
  events: readonly SourceCorrelatedEvent[];
  diagnostics: readonly ProgressDiagnostic[];
}

export interface ProgressActionInputCopy {
  key: string;
  from?: string;
  value?: unknown;
}

export interface ProgressActionDescriptor {
  id: string;
  label: string;
  target?: string;
  operation?: string;
  definitionId?: string;
  definitionIds?: readonly string[];
  input?: JsonRecord;
  copy?: readonly ProgressActionInputCopy[];
}

export interface ProgressActionContext {
  row?: RecordProgressRow | null;
  event?: SourceCorrelatedEvent | null;
  answers?: Readonly<JsonRecord>;
}

export interface ProgressActionRequest {
  target: string;
  payload: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.').filter(Boolean)) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function compareNullableTime(left: number | null, right: number | null): number {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  return leftValue - rightValue;
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function diagnostic(code: string, message: string, raw?: unknown): ProgressDiagnostic {
  return { code, message, raw };
}

export function decodeSourceRef(raw: unknown): SourceRecordRef | ProgressDiagnostic {
  if (!isRecord(raw)) return diagnostic('source-ref-invalid', 'Source reference is not an object.', raw);
  const address = asNonEmptyString(raw.address);
  if (!address) return diagnostic('source-address-missing', 'Source reference has no address.', raw);
  return {
    address,
    label: asNonEmptyString(raw.label) ?? undefined,
    kind: asNonEmptyString(raw.kind) ?? undefined,
    archived: raw.archived === true,
    raw,
  };
}

export function decodeSourceCorrelatedEvent(raw: unknown): SourceCorrelatedEvent | ProgressDiagnostic {
  if (!isRecord(raw)) return diagnostic('event-invalid', 'Event is not an object.', raw);
  const id = asNonEmptyString(raw.id);
  const producer = asNonEmptyString(raw.producer);
  const state = asNonEmptyString(raw.state);
  const occurredAtMs = asFiniteNumber(raw.occurredAtMs);
  const source = decodeSourceRef(raw.source);
  if ('code' in source) return { ...source, eventId: id ?? undefined, producer: producer ?? undefined };
  if (!id) return diagnostic('event-id-missing', 'Event has no id.', raw);
  if (!producer) return diagnostic('producer-missing', 'Event has no producer.', raw);
  if (!state) return diagnostic('state-missing', 'Event has no state.', raw);
  if (occurredAtMs == null) return diagnostic('event-time-invalid', 'Event has no finite timestamp.', raw);
  return {
    id,
    source,
    producer,
    occurredAtMs,
    state,
    summary: asNonEmptyString(raw.summary) ?? undefined,
    detail: asNonEmptyString(raw.detail) ?? undefined,
    proofRefs: Array.isArray(raw.proofRefs)
      ? raw.proofRefs.filter(isRecord).map((proof, index) => ({
        id: asNonEmptyString(proof.id) ?? `${id}:proof:${index}`,
        label: asNonEmptyString(proof.label) ?? 'Proof',
        address: asNonEmptyString(proof.address) ?? undefined,
        url: asNonEmptyString(proof.url) ?? undefined,
        filePath: asNonEmptyString(proof.filePath) ?? undefined,
        contentAddress: asNonEmptyString(proof.contentAddress) ?? undefined,
        raw: proof,
      }))
      : [],
    diagnosticRefs: Array.isArray(raw.diagnosticRefs)
      ? raw.diagnosticRefs.filter(isRecord).map((entry, index) => ({
        code: asNonEmptyString(entry.code) ?? `${id}:diagnostic:${index}`,
        message: asNonEmptyString(entry.message) ?? 'Diagnostic',
        sourceAddress: asNonEmptyString(entry.sourceAddress) ?? source.address,
        producer: asNonEmptyString(entry.producer) ?? producer,
        eventId: asNonEmptyString(entry.eventId) ?? id,
        severity: asNonEmptyString(entry.severity) ?? undefined,
        raw: entry,
      }))
      : [],
    raw,
  };
}

export function projectSourceCorrelatedRecords(rawEvents: readonly unknown[]): SourceCorrelatedProjection {
  const events: SourceCorrelatedEvent[] = [];
  const diagnostics: ProgressDiagnostic[] = [];
  for (const raw of rawEvents) {
    const decoded = decodeSourceCorrelatedEvent(raw);
    if ('source' in decoded) {
      events.push(decoded);
      diagnostics.push(...decoded.diagnosticRefs ?? []);
    } else {
      diagnostics.push(decoded);
    }
  }

  events.sort((left, right) => {
    const bySource = left.source.address.localeCompare(right.source.address);
    if (bySource !== 0) return bySource;
    const byTime = left.occurredAtMs - right.occurredAtMs;
    if (byTime !== 0) return byTime;
    return left.id.localeCompare(right.id);
  });

  const bySource = new Map<string, SourceCorrelatedEvent[]>();
  for (const event of events) {
    bySource.set(event.source.address, [...(bySource.get(event.source.address) ?? []), event]);
  }

  const rows = [...bySource.entries()].map(([sourceAddress, sourceEvents]) => {
    const sorted = [...sourceEvents].sort((left, right) => {
      const byTime = left.occurredAtMs - right.occurredAtMs;
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
    const latest = sorted[sorted.length - 1] ?? null;
    const source = latest?.source ?? sorted[0].source;
    const proofRefs = uniqueBy(sorted.flatMap((event) => event.proofRefs ?? []), (proof) => proof.id);
    const diagnosticRefs = uniqueBy(sorted.flatMap((event) => event.diagnosticRefs ?? []), (entry) => entry.code);
    const producerRefs = [...new Set(sorted.map((event) => event.producer))].sort();
    return {
      id: `record-progress:${sourceAddress}`,
      source,
      currentState: latest?.state ?? 'unknown',
      summary: latest?.summary ?? source.label ?? sourceAddress,
      latestEventAtMs: latest?.occurredAtMs ?? null,
      eventCount: sorted.length,
      producerRefs,
      proofRefs,
      diagnosticRefs,
      events: sorted,
      raw: {
        sourceAddress,
        sourceKind: source.kind,
      },
    } satisfies RecordProgressRow;
  });

  rows.sort((left, right) => {
    const byTime = compareNullableTime(right.latestEventAtMs, left.latestEventAtMs);
    return byTime !== 0 ? byTime : left.source.address.localeCompare(right.source.address);
  });

  return { rows, events, diagnostics };
}

export function markUnavailableSources(
  sources: readonly SourceRecordRef[],
  events: readonly SourceCorrelatedEvent[],
  state = 'source-unavailable',
): SourceCorrelatedEvent[] {
  const eventSources = new Set(events.map((event) => event.source.address));
  const synthesized = sources
    .filter((source) => !eventSources.has(source.address) || source.archived)
    .map((source) => ({
      id: `source-state:${source.address}`,
      source,
      producer: 'source-record',
      occurredAtMs: 0,
      state,
      summary: source.label ?? source.address,
      diagnosticRefs: source.archived
        ? [{
          code: 'source-archived',
          message: 'The source record is archived.',
          sourceAddress: source.address,
          producer: 'source-record',
        }]
        : [],
    } satisfies SourceCorrelatedEvent));
  return [...events, ...synthesized];
}

export function buildProgressActionRequest(
  action: ProgressActionDescriptor,
  context: ProgressActionContext,
): ProgressActionRequest {
  const copied: JsonRecord = {};
  for (const entry of action.copy ?? []) {
    const value = entry.from ? readPath(context, entry.from) : entry.value;
    if (value !== undefined) copied[entry.key] = value;
  }
  return {
    target: action.target ?? 'slot::workflow',
    payload: {
      operation: action.operation ?? 'execute_definition',
      definition_id: action.definitionId,
      definition_ids: action.definitionIds ?? [],
      input: {
        ...(action.input ?? {}),
        ...(context.answers ?? {}),
        ...copied,
        action_id: action.id,
      },
    },
  };
}
