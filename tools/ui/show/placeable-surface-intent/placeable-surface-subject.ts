// packages/ui/show/placeable-surface-intent/placeable-surface-subject.ts
//
// Browser-local store for opaque things admitted through placeable surfaces.
// Callers share one subjectRef address; they do not pass byte lanes or handles
// through screen-arrangement tab metadata.

export interface PlaceableSurfaceSubjectRef {
  readonly address: string;
}

export interface PlaceableSurfaceSubjectDisplay {
  readonly name?: string;
  readonly content_type?: string;
  readonly byte_length?: number;
}

export interface PlaceableSurfaceSubjectSnapshot {
  readonly kind: 'placeable-surface-subject';
  readonly ref: PlaceableSurfaceSubjectRef;
  readonly origin?: Record<string, unknown>;
  readonly display?: PlaceableSurfaceSubjectDisplay;
  readonly content?: Record<string, unknown>;
  readonly handle?: unknown;
}

export interface PlaceableSurfaceSubjectAdmission {
  readonly address?: string;
  readonly origin?: Record<string, unknown>;
  readonly display?: PlaceableSurfaceSubjectDisplay;
  readonly content?: Record<string, unknown>;
  readonly handle?: unknown;
}

const SUBJECT_PREFIX = 'bitfield-subject';
const SUBJECT_STATE_SYMBOL = Symbol.for('bitfield.placeableSurfaceSubjectState');

interface SubjectState {
  readonly store: Map<string, PlaceableSurfaceSubjectSnapshot>;
  fallbackCounter: number;
}

function sharedSubjectState(): SubjectState {
  const root = globalThis as { [key: symbol]: SubjectState | undefined };
  const existing = root[SUBJECT_STATE_SYMBOL];
  if (existing) return existing;
  const next = {
    store: new Map<string, PlaceableSurfaceSubjectSnapshot>(),
    fallbackCounter: 0,
  };
  root[SUBJECT_STATE_SYMBOL] = next;
  return next;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function nextSubjectAddress(): string {
  const state = sharedSubjectState();
  const randomUUID = globalThis.crypto?.randomUUID;
  const id = typeof randomUUID === 'function'
    ? randomUUID.call(globalThis.crypto)
    : `${Date.now().toString(36)}-${(state.fallbackCounter += 1).toString(36)}`;
  return `${SUBJECT_PREFIX}:${id}`;
}

function normalizeRef(value: PlaceableSurfaceSubjectRef | string): PlaceableSurfaceSubjectRef | null {
  const address = typeof value === 'string' ? value : value.address;
  const normalized = nonEmptyString(address);
  return normalized ? { address: normalized } : null;
}

export function admitPlaceableSurfaceSubject(
  admission: PlaceableSurfaceSubjectAdmission,
): PlaceableSurfaceSubjectSnapshot {
  const address = nonEmptyString(admission.address) ?? nextSubjectAddress();
  const snapshot: PlaceableSurfaceSubjectSnapshot = {
    kind: 'placeable-surface-subject',
    ref: { address },
    ...(admission.origin ? { origin: admission.origin } : {}),
    ...(admission.display ? { display: admission.display } : {}),
    ...(admission.content ? { content: admission.content } : {}),
    ...(admission.handle === undefined ? {} : { handle: admission.handle }),
  };
  sharedSubjectState().store.set(address, snapshot);
  return snapshot;
}

export function readPlaceableSurfaceSubject(
  value: PlaceableSurfaceSubjectRef | string,
): PlaceableSurfaceSubjectSnapshot | null {
  const ref = normalizeRef(value);
  return ref ? sharedSubjectState().store.get(ref.address) ?? null : null;
}

export function forgetPlaceableSurfaceSubject(
  value: PlaceableSurfaceSubjectRef | string,
): boolean {
  const ref = normalizeRef(value);
  return ref ? sharedSubjectState().store.delete(ref.address) : false;
}
