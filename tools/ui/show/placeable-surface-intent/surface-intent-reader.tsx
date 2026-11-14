// packages/ui/show/placeable-surface-intent/surface-intent-reader.tsx
//
// Emit-mode of the surface-intent primitive: watch a record stream and emit a
// placeable-surface intent for each NEW record whose disposition ROUTES to
// "emit" and passes the permit policy. A record's disposition is an OPEN
// string; which dispositions emit is caller DATA (`dispositionRoutes`), never
// a code branch. Dedup is by a stable per-record key; a record with no key is
// never auto-emitted (fail-safe against re-emit loops).

import * as React from 'react';

import {
  emitPlaceableSurfaceIntent,
  type PlaceableSurfacePayload,
} from './placeable-surface-intent';
import {
  readSurfaceIntentPayload,
  surfaceIntentAllowed,
  type SurfaceIntentAllowEntry,
  type SurfaceIntentPermit,
} from './record-surface-intent';

/** A record's disposition key — OPEN data; producers may invent new ones. */
export type SurfaceIntentDisposition = string;

/**
 * The primitive owns exactly two mechanisms (Physics): emit the intent now, or
 * hand the record to the button path. `dispositionRoutes` maps OPEN disposition
 * keys onto those mechanisms; a new producer disposition is one DATA row here,
 * zero code. Unrouted keys take `defaultRoute`.
 */
export type SurfaceIntentRoute = 'emit' | 'button';
export type SurfaceIntentDispositionRoutes = Readonly<Record<string, SurfaceIntentRoute>>;

export const DEFAULT_DISPOSITION_ROUTES: SurfaceIntentDispositionRoutes = { auto: 'emit' };
export const DEFAULT_DISPOSITION_ROUTE: SurfaceIntentRoute = 'button';

export interface ResolveAutoEmitOptions {
  readonly intentPath: readonly string[];
  readonly allowList: readonly SurfaceIntentAllowEntry[];
  readonly permit?: SurfaceIntentPermit;
  readonly seen: ReadonlySet<string>;
  readonly keyPath?: readonly string[];
  readonly dispositionRoutes?: SurfaceIntentDispositionRoutes;
  readonly defaultRoute?: SurfaceIntentRoute;
}

export interface AutoEmitResult {
  readonly payloads: readonly PlaceableSurfacePayload[];
  /** Keys align with payloads; they are candidates until emit acknowledges. */
  readonly keys: readonly string[];
  readonly seen: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function navigate(record: unknown, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** A record's disposition key as written by the producer (open string; '' when absent). */
export function readSurfaceIntentDisposition(
  record: unknown,
  intentPath: readonly string[],
): SurfaceIntentDisposition {
  const raw = navigate(record, intentPath);
  return isRecord(raw) && typeof raw.disposition === 'string' ? raw.disposition : '';
}

/** Resolve a disposition key to its mechanism via the routes DATA (fail-safe to defaultRoute). */
export function routeSurfaceIntentDisposition(
  disposition: SurfaceIntentDisposition,
  routes: SurfaceIntentDispositionRoutes = DEFAULT_DISPOSITION_ROUTES,
  defaultRoute: SurfaceIntentRoute = DEFAULT_DISPOSITION_ROUTE,
): SurfaceIntentRoute {
  return routes[disposition] ?? defaultRoute;
}

function readKey(record: unknown, keyPath: readonly string[]): string | null {
  const value = navigate(record, keyPath);
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Given the current record stream and the keys already emitted, return the
 * payloads to emit now plus the grown seen-set. Only records that are new
 * (keyed, not in seen), route to "emit", carry a valid intent, and pass the
 * permit policy are emitted; only emitted keys enter the seen-set, so a record
 * whose disposition later routes to emit is still catchable.
 */
export function resolveAutoEmitSurfaceIntents(
  records: readonly unknown[],
  options: ResolveAutoEmitOptions,
): AutoEmitResult {
  const seen = new Set(options.seen);
  const payloads: PlaceableSurfacePayload[] = [];
  const keys: string[] = [];
  const keyPath = options.keyPath ?? ['id'];
  for (const record of records) {
    const key = readKey(record, keyPath);
    if (key === null || seen.has(key)) continue;
    const disposition = readSurfaceIntentDisposition(record, options.intentPath);
    if (routeSurfaceIntentDisposition(disposition, options.dispositionRoutes, options.defaultRoute) !== 'emit') continue;
    const payload = readSurfaceIntentPayload(record, options.intentPath);
    if (!payload || !surfaceIntentAllowed(payload, options.allowList, options.permit)) continue;
    payloads.push(payload);
    keys.push(key);
    seen.add(key);
  }
  return { payloads, keys, seen };
}

export interface SurfaceIntentReaderProps {
  readonly records: readonly unknown[];
  readonly intentPath: readonly string[];
  readonly allowList: readonly SurfaceIntentAllowEntry[];
  readonly permit?: SurfaceIntentPermit;
  readonly keyPath?: readonly string[];
  readonly dispositionRoutes?: SurfaceIntentDispositionRoutes;
  readonly defaultRoute?: SurfaceIntentRoute;
  /** A destination acknowledges only after its existing owner mutation commits. */
  readonly emit?: (payload: PlaceableSurfacePayload) => boolean | Promise<boolean>;
  /** Optional transient-request lifecycle hook; fires when no owner work remains in flight. */
  readonly onSettled?: () => void;
}

/**
 * Renders nothing; on each record-stream change, emits the new permitted
 * intents that route to "emit". The caller supplies `records` (e.g. from
 * useBitfieldData) so this component stays data-source agnostic and testable.
 * `emit` is injectable; routing is DATA.
 */
export function SurfaceIntentReader({
  records,
  intentPath,
  allowList,
  permit,
  keyPath,
  dispositionRoutes,
  defaultRoute,
  emit = emitPlaceableSurfaceIntent,
  onSettled,
}: SurfaceIntentReaderProps): null {
  const seenRef = React.useRef<Set<string>>(new Set());
  const activeKeysRef = React.useRef<ReadonlySet<string>>(new Set());
  const pendingRef = React.useRef<Map<string, symbol>>(new Map());
  React.useEffect(() => {
    const activeKeys = new Set<string>();
    for (const record of records) {
      const key = readKey(record, keyPath ?? ['id']);
      if (key !== null) activeKeys.add(key);
    }
    activeKeysRef.current = activeKeys;

    // Completion memory is only a bounded view of the CURRENT source window.
    // Durable once-only placement belongs to each destination owner. Retiring
    // absent keys here prevents this generic reader from becoming a second,
    // unbounded delivery ledger.
    seenRef.current = new Set([...seenRef.current].filter((key) => activeKeys.has(key)));
    const pending = pendingRef.current;
    for (const key of pending.keys()) {
      if (!activeKeys.has(key)) pending.delete(key);
    }
    // Do not pass pending keys into the pure resolver as seen: failure must be
    // visible to a later reactive read and retry rather than being lost.
    const candidates = records.filter((record) => {
      const key = readKey(record, keyPath ?? ['id']);
      return key === null || !pending.has(key);
    });
    const result = resolveAutoEmitSurfaceIntents(candidates, {
      intentPath,
      allowList,
      permit,
      seen: seenRef.current,
      keyPath,
      dispositionRoutes,
      defaultRoute,
    });
    result.payloads.forEach((payload, index) => {
      const key = result.keys[index];
      if (!key) return;
      const attempt = Symbol(key);
      pending.set(key, attempt);
      void Promise.resolve(emit(payload)).then((accepted) => {
        if (pending.get(key) !== attempt) return;
        pending.delete(key);
        // The acknowledgement belongs to this reader instance, not to one
        // particular effect generation. A dependency change while the owner's
        // commit is in flight must not make the same durable placement eligible
        // again on the next render. A record that left the source window is not
        // retained: the durable destination, not this reader, owns replay proof.
        if (accepted && activeKeysRef.current.has(key)) seenRef.current.add(key);
        if (pending.size === 0) onSettled?.();
      }).catch(() => {
        if (pending.get(key) !== attempt) return;
        pending.delete(key);
        if (pending.size === 0) onSettled?.();
      });
    });
    if (result.payloads.length === 0 && pending.size === 0) onSettled?.();
  }, [records, intentPath, allowList, permit, keyPath, dispositionRoutes, defaultRoute, emit, onSettled]);
  return null;
}
