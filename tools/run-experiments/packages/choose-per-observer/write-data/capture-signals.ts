// packages/choose-per-observer/write-data/capture-signals.ts
//
// Purpose: Capture observer identity and first-touch signals as observation facts.
// Identity resolution is DATA-driven (ordered descriptor list), not code-enumerated.
// Signals are also DATA-driven (path + extractor pairs).
//
// Non-negotiable invariants:
//   1. ObserverID derivation is an ORDERED DATA list of source descriptors
//      (cookie → header → device-key → anon-hash). First match wins.
//      NEVER a fixed code precedence.
//   2. Signals-to-capture are a DATA {path, extractor} list. New signal = 1 data row.
//      NEVER hardcoded signal names or extractors in code.
//   3. Signals are stored as `trust:observer-supplied` facts (caller's input).
//   4. Same input → deterministic observer_id (idempotent identity).
//   5. Multiple calls with same input → same observer_id.
//
// Dependencies: appendObservation (injected), pure buildSignals helpers.

import type { WriteBatchEntry } from './observe';
import {
  appendObservation,
  buildObservationRecord,
  buildWriteBatchEntry,
  type ObserveOptions,
} from './observe';

// ---------------------------------------------------------------------------
// ObserverID derivation — DATA-driven source precedence
// ---------------------------------------------------------------------------

/**
 * One source descriptor for deriving observer_id.
 * The actual value lookup is performed by the caller; this describes
 * which source to check and how to extract from it.
 */
export interface ObserverIdSource {
  source_id: string;
  extractor?: Record<string, unknown>;
}

/**
 * Observer ID resolved from sources (first non-null source wins).
 *
 * `observer_id`     — the derived stable identifier.
 * `matched_source`  — which source_id matched (for observability).
 * `as_timestamp`    — ISO 8601 UTC when this identity was derived.
 */
export interface ObserverId {
  observer_id: string;
  matched_source: string;
  as_timestamp: string;
}

/**
 * Derive a stable observer_id from an ordered list of sources.
 * First non-null source wins; uses that value as the observer_id.
 * Idempotent: same sources → same observer_id.
 *
 * @param sources      Ordered source list [{source_id, value}] with values.
 * @returns            The resolved observer ID.
 * @throws             If all sources are null/empty.
 */
export function deriveObserverId(
  sources: Array<{ source_id: string; value: string | null }>,
): ObserverId {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('[choose-per-observer] captureSignals: sources must be a non-empty array.');
  }

  for (const source of sources) {
    if (typeof source.value === 'string' && source.value.trim().length > 0) {
      return {
        observer_id: source.value.trim(),
        matched_source: source.source_id,
        as_timestamp: new Date().toISOString(),
      };
    }
  }

  throw new Error(
    '[choose-per-observer] captureSignals: no source provided a non-null value.',
  );
}

// ---------------------------------------------------------------------------
// Signal capture — DATA-driven
// ---------------------------------------------------------------------------

/**
 * One signal descriptor: where to store it and how to extract from context.
 */
export interface SignalDescriptor {
  path: string[];
  extractor?: Record<string, unknown>;
}

/**
 * First-touch context: the request/session context at the time of observation.
 * Structure is caller-defined; signal descriptors extract from it.
 */
export interface FirstTouchContext {
  source?: string;
  referrer?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  geo?: string | null;
  device?: string | null;
  is_returning?: boolean;
  [key: string]: unknown;
}

/**
 * Extract a signal value from the first-touch context using a descriptor.
 * If extractor has a 'key' field, return context[key]. Otherwise return context.
 *
 * @param context      The first-touch context.
 * @param descriptor   The signal descriptor (includes optional extractor).
 * @returns            The extracted value (any type).
 */
export function extractSignalValue(
  context: FirstTouchContext,
  descriptor: SignalDescriptor,
): unknown {
  if (!descriptor.extractor) {
    return context;
  }

  const keyField = (descriptor.extractor as Record<string, unknown>)['key'];
  if (typeof keyField === 'string') {
    return context[keyField] ?? null;
  }

  return context;
}

/**
 * Build observation facts for all signals, given a signal descriptor list.
 * Returns ObserveOptions ready for appendObservation.
 *
 * @param observerId    The derived observer_id.
 * @param context       First-touch context.
 * @param signals       Ordered list of signal descriptors.
 * @returns             Array of ObserveOptions (one per signal).
 */
export function buildSignals(
  observerId: string,
  context: FirstTouchContext,
  signals: SignalDescriptor[],
): ObserveOptions[] {
  const options: ObserveOptions[] = [];
  const now = new Date().toISOString();

  for (const signal of signals) {
    if (!Array.isArray(signal.path) || signal.path.length === 0) {
      console.warn('[choose-per-observer] buildSignals: skipping signal with invalid path:', signal);
      continue;
    }

    const value = extractSignalValue(context, signal);

    options.push({
      observerId,
      trustRef: 'trust:observer-supplied',
      path: signal.path,
      value,
      at: now,
    });
  }

  return options;
}

// ---------------------------------------------------------------------------
// captureSignals — orchestrator: derive ID + build + append signals
// ---------------------------------------------------------------------------

/**
 * Options for capturing observer signals.
 */
export interface CaptureSignalsOptions {
  sources: Array<{ source_id: string; value: string | null }>;
  context: FirstTouchContext;
  signals: SignalDescriptor[];
}

/**
 * Capture observer identity and first-touch signals.
 *
 * Flow:
 *   1. Derive observer_id from sources (first non-null source wins).
 *   2. Build signal facts using signal descriptors.
 *   3. Append all signals via appendObservation.
 *
 * Idempotent: same sources + same context → same observer_id, same signals.
 *
 * @param options              Capture options (sources, context, signals).
 * @param engineWriteBatch     Injected engine write function.
 * @returns                    The derived observer_id and list of appended addresses.
 */
export async function captureSignals(
  options: CaptureSignalsOptions,
  engineWriteBatch: (entries: WriteBatchEntry[]) => Promise<void>,
): Promise<{ observer_id: string; signal_addresses: string[] }> {
  const { sources, context, signals } = options;

  const identity = deriveObserverId(sources);
  console.log(
    `[choose-per-observer] captureSignals: observer_id derived from source=${identity.matched_source}`,
  );

  const signalOptions = buildSignals(identity.observer_id, context, signals);

  const signal_addresses: string[] = [];
  for (const opt of signalOptions) {
    const { record, address } = buildObservationRecord(opt);
    signal_addresses.push(address);
  }

  const entries: WriteBatchEntry[] = signalOptions.map((opt) => buildWriteBatchEntry(opt));
  if (entries.length > 0) {
    await engineWriteBatch(entries);
  }

  console.log(
    `[choose-per-observer] captureSignals: appended observer=${identity.observer_id} signal_count=${entries.length}`,
  );

  return { observer_id: identity.observer_id, signal_addresses };
}
