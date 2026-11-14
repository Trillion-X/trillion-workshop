import { projectWorkFlowFeed, type WorkFlowFeedView } from './work-flow-feed';
import type { SourceRecordRef } from './source-correlated-records';

type Row = Record<string, unknown>;

const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : null;
const nonempty = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

export interface ObservedMessageWorkRef {
  atomRef: string;
  recordRef: string;
  observedAtMs: number;
}

export interface MessageWorkReadback {
  taskAddress: string;
  requestAt?: string;
  claimAt?: string;
  claimStatus?: string;
}

/** Only attributed human turns enter Request Intake. Bound visible lookups. */
export function observedMessageWorkRefs(
  ledgersBySource: Readonly<Record<string, unknown>>,
  limit = 8,
): ObservedMessageWorkRef[] {
  const refs = new Map<string, ObservedMessageWorkRef>();
  for (const [sourceRef, rawLedger] of Object.entries(ledgersBySource)) {
    const accepted = row(rawLedger)?.accepted;
    if (!Array.isArray(accepted)) continue;
    for (const raw of accepted) {
      const observation = row(raw);
      const payload = row(observation?.payload);
      const atomRef = nonempty(payload?.atom_ref);
      const nativeRef = nonempty(payload?.native_ref) ?? atomRef;
      const speaker = nonempty(payload?.speaker_ref);
      const observedAt = nonempty(observation?.observed_at);
      const observedAtMs = observedAt ? Date.parse(observedAt) : NaN;
      if (observation?.source_ref !== sourceRef || !atomRef || !nativeRef ||
          !speaker?.endsWith(':user') || !Number.isFinite(observedAtMs)) continue;
      refs.set(atomRef, { atomRef, recordRef: `request:${sourceRef}:${nativeRef}`, observedAtMs });
    }
  }
  return [...refs.values()]
    .sort((a, b) => b.observedAtMs - a.observedAtMs || a.recordRef.localeCompare(b.recordRef))
    .slice(0, Math.max(0, Math.min(32, limit)));
}

/** Source IDs come from the current observation plan, never a built-in provider list. */
export function observedSourcesFromPlan(rawPlan: unknown): SourceRecordRef[] {
  const entries = row(rawPlan)?.plan;
  if (!Array.isArray(entries)) return [];
  const sources = new Map<string, SourceRecordRef>();
  for (const raw of entries) {
    const entry = row(raw);
    const sourceRef = nonempty(entry?.source_ref);
    if (!sourceRef) continue;
    const descriptor = row(entry?.descriptor);
    sources.set(sourceRef, {
      address: sourceRef,
      label: nonempty(descriptor?.label) ?? nonempty(descriptor?.display_name) ?? sourceRef,
      kind: nonempty(descriptor?.kind) ?? undefined,
    });
  }
  return [...sources.values()];
}

export function observedLedgerAddress(sourceRef: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sourceRef) || sourceRef.includes('::')) {
    throw new Error('Invalid observed source reference.');
  }
  return `package::observed-content::ledger::${sourceRef}`;
}

function decodedPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

/** Convert the owner's scoped live feed rows to the plan and per-source ledgers. */
export function observedContentFeedRows(rawFeed: unknown): {
  plan: unknown;
  planAvailable: boolean;
  ledgersBySource: Record<string, unknown>;
} {
  const ledgersBySource: Record<string, unknown> = {};
  let plan: unknown = null;
  let planAvailable = false;
  if (!Array.isArray(rawFeed)) return { plan, planAvailable, ledgersBySource };
  for (const value of rawFeed) {
    const feedRow = row(value);
    const record = row(feedRow?.record);
    const address = nonempty(feedRow?.address) ?? nonempty(record?.address);
    if (!address) continue;
    const payload = decodedPayload(feedRow?.payload);
    if (address === 'package::observed-content::observation-plan') {
      plan = payload;
      planAvailable = true;
    } else if (address.startsWith('package::observed-content::ledger::')) {
      const sourceRef = address.slice('package::observed-content::ledger::'.length);
      if (sourceRef) ledgersBySource[sourceRef] = payload;
    }
  }
  return { plan, planAvailable, ledgersBySource };
}

/**
 * Readback adapter. A missing ledger remains a visible unavailable source.
 * Accepted observations are real source arrivals; task links are added only
 * when the request/task owner supplies the exact message identity. The
 * observation correlation_ref names a batch and cannot identify a message.
 */
export function projectObservedContentFlow(
  rawPlan: unknown,
  ledgersBySource: Readonly<Record<string, unknown>>,
  taskAddressByMessage: Readonly<Record<string, string>>,
  nowMs: number,
  staleAfterMs: number,
  planAvailable: boolean,
  workByMessage: Readonly<Record<string, MessageWorkReadback>> = {},
): WorkFlowFeedView {
  const sources = observedSourcesFromPlan(rawPlan);
  if (!planAvailable) return projectWorkFlowFeed([], sources, nowMs, staleAfterMs, false);
  if (!Array.isArray(row(rawPlan)?.plan)) return projectWorkFlowFeed(null, sources, nowMs, staleAfterMs, true);

  const events: Row[] = [];
  let invalidLedger = false;
  for (const source of sources) {
    const rawLedger = ledgersBySource[source.address];
    if (rawLedger === undefined || rawLedger === null) continue;
    const accepted = row(rawLedger)?.accepted;
    if (!Array.isArray(accepted)) { invalidLedger = true; continue; }
    for (const raw of accepted) {
      const observation = row(raw);
      if (!observation || observation.source_ref !== source.address) { invalidLedger = true; continue; }
      const identity = nonempty(observation.source_identity_ref);
      const revision = nonempty(observation.source_revision_ref);
      const correlation = nonempty(observation.correlation_ref);
      const payload = row(observation.payload);
      const atomRef = nonempty(payload?.atom_ref);
      const nativeRef = nonempty(payload?.native_ref) ?? nonempty(observation.native_ref);
      const observedAt = nonempty(observation.observed_at);
      const occurredAtMs = observedAt ? Date.parse(observedAt) : NaN;
      if (!identity || !revision || !correlation || !Number.isFinite(occurredAtMs)) {
        invalidLedger = true;
        continue;
      }
      const work = atomRef ? workByMessage[atomRef] : undefined;
      const taskAddress = atomRef ? nonempty(taskAddressByMessage[atomRef]) ?? nonempty(work?.taskAddress) : null;
      const nativeTaskAddress = nativeRef ? nonempty(taskAddressByMessage[`${source.address}:${nativeRef}`]) : null;
      const linkedTask = taskAddress ?? nativeTaskAddress;
      events.push({
        id: `${identity}@${revision}`,
        source,
        producer: 'observed-content',
        occurredAtMs,
        state: 'observed',
        summary: 'Source item observed',
        ...(linkedTask ? { taskAddress: linkedTask } : {}),
      });
      if (linkedTask && work) {
        const requestAtMs = work.requestAt ? Date.parse(work.requestAt) : NaN;
        if (Number.isFinite(requestAtMs)) events.push({
          id: `${identity}@${revision}:request`, source,
          producer: 'request-intake', occurredAtMs: requestAtMs,
          state: 'request-recorded', summary: 'Request recorded', taskAddress: linkedTask,
        });
        const claimAtMs = work.claimAt ? Date.parse(work.claimAt) : NaN;
        if (Number.isFinite(claimAtMs)) events.push({
          id: `${identity}@${revision}:claim`, source,
          producer: 'request-intake', occurredAtMs: claimAtMs,
          state: 'execution-claim-recorded',
          summary: work.claimStatus === 'pending-owner-route' ? 'Work awaiting its owner' : 'Execution claim recorded',
          taskAddress: linkedTask,
        });
      }
    }
  }
  const view = projectWorkFlowFeed(events, sources, nowMs, staleAfterMs, true);
  return invalidLedger ? { ...view, state: 'invalid' } : view;
}
