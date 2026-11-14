// packages/ui/show/placeable-surface-intent/placeable-surface-intent.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Browser-local activation contract for "place this surface where the active
// screen arrangement can accept it." Producers emit an opaque payload. The
// screen-arrangement package decides whether and how that payload becomes a tab.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This file owns only the browser event/data-transfer shape
// 2. It never imports screen-arrangement, sidebar, command-palette, or package data
// 3. It never chooses a container, creates a tab, or mutates durable layout state
// 4. A canceled event means one blind consumer accepted the intent
// 5. Payload parsing is tolerant; placement semantics remain caller-owned
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { readOpenPlacement, type OpenPlacement } from './placeable-surface-record';

export const PLACEABLE_SURFACE_MIME = 'application/x-placeable-surface+json';
export const PLACEABLE_SURFACE_COMPLETED_EVENT = 'bitfield:placeable-surface-completed';
const PENDING_PLACEABLE_SURFACE_INTENTS = Symbol.for('bitfield.placeable-surface.pending-intents');

export interface PlaceableSurfaceCompletionDetail {
  readonly completionRef: string;
}

type JsonRecord = Record<string, unknown>;

export interface PlaceableSurfacePackageEntryReference {
  readonly packageName: string;
  readonly entryName: string;
}

export interface PlaceableSurfacePayload {
  readonly version?: number;
  readonly id?: string;
  readonly title?: string;
  readonly target?: string | null;
  readonly packageEntry?: PlaceableSurfacePackageEntryReference | null;
  readonly materialTarget?: string | null;
  readonly icon?: string;
  readonly material?: JsonRecord;
  readonly surfaceInput?: JsonRecord;
  /** Open a new tiled container beside the active container. */
  readonly placement?: 'right' | 'below';
  readonly placementTargetContainerId?: string;
  /** What kind of thing the surface shows (the record's own record_kind and
   *  an optional detail), drawn next to the title wherever it is placed. */
  readonly recordKind?: PlaceableSurfaceRecordKind;
  /** The `surface_instance_ref` an open tab was mounted with: this surface takes that tab's place (same tab, same
   *  pane) instead of opening beside it. A screen whose subject gains a lasting address (a dropped file once it is
   *  uploaded) sends it so the tab reopens from that address. */
  readonly replacesInstance?: string;
  /** Where this one open places the screen when it names a layer (`open_placement`), in place of the screen's own. */
  readonly openPlacement?: OpenPlacement;
}

export interface PlaceableSurfaceRecordKind {
  readonly kind: string;
  readonly detail?: string;
}

function pendingPlaceableSurfaceIntents(): PlaceableSurfacePayload[] {
  // Sidebar and arrangement are separate browser entry bundles. A module-local
  // array would be copied into each bundle and the receiver would see nothing.
  const host = window as unknown as Record<symbol, PlaceableSurfacePayload[]>;
  return host[PENDING_PLACEABLE_SURFACE_INTENTS] ??= [];
}

/** A browser-local request for one opaque destination to consume an addressed
 * source. It deliberately carries no producer, record, package, or result
 * vocabulary: source resolution remains mount DATA and owner mutation remains
 * the receiving surface's job. */
export type AddressedSurfaceIntentSource = string | {
  readonly input: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

export interface AddressedSurfaceIntentRequest {
  readonly destinationRef: string;
  /** Opaque caller identity for one durable delivery; never synthesized by a receiver. */
  readonly deliveryRef: string;
  readonly source: AddressedSurfaceIntentSource;
  readonly intentPath: readonly string[];
  readonly keyPath?: readonly string[];
  readonly dispositionRoutes?: Readonly<Record<string, 'emit' | 'button'>>;
  readonly defaultRoute?: 'emit' | 'button';
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readFirstString(record: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return null;
}

function readPackageEntry(value: unknown): PlaceableSurfacePackageEntryReference | null {
  if (!isRecord(value)) return null;
  const packageName = readString(value.packageName) ?? readString(value.package_name);
  const entryName = readString(value.entryName) ?? readString(value.entry_name);
  if (!packageName || !entryName) return null;
  return { packageName, entryName };
}

function readRecordKind(value: unknown): PlaceableSurfaceRecordKind | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (!kind) return null;
  const detail = readString(value.detail);
  return detail ? { kind, detail } : { kind };
}

function readPayloadRecord(parsed: JsonRecord): PlaceableSurfacePayload {
  const surfaceInput = parsed.surfaceInput ?? parsed.surface_input;
  const material = parsed.material;
  return {
    version: typeof parsed.version === 'number' ? parsed.version : undefined,
    id: readString(parsed.id) ?? undefined,
    title: readString(parsed.title) ?? readString(parsed.label) ?? undefined,
    target: readString(parsed.target) ?? readString(parsed.address) ?? null,
    packageEntry: readPackageEntry(parsed.packageEntry ?? parsed.package_entry),
    materialTarget: readFirstString(parsed, ['materialTarget', 'material_target']) ?? null,
    icon: readString(parsed.icon) ?? undefined,
    ...(isRecord(material) ? { material } : {}),
    ...(isRecord(surfaceInput) ? { surfaceInput } : {}),
    ...(parsed.placement === 'right' || parsed.placement === 'below' ? { placement: parsed.placement } : {}),
    ...(readString(parsed.placementTargetContainerId) ? { placementTargetContainerId: readString(parsed.placementTargetContainerId)! } : {}),
    ...(readRecordKind(parsed.recordKind ?? parsed.record_kind) ? { recordKind: readRecordKind(parsed.recordKind ?? parsed.record_kind)! } : {}),
    ...(readString(parsed.replacesInstance ?? parsed.replaces_instance) ? { replacesInstance: readString(parsed.replacesInstance ?? parsed.replaces_instance)! } : {}),
    ...(readOpenPlacement(parsed.openPlacement ?? parsed.open_placement) ? { openPlacement: readOpenPlacement(parsed.openPlacement ?? parsed.open_placement)! } : {}),
  };
}

function readPath(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((part) => typeof part === 'string' && part.length > 0) ? value : null;
}

function readAddressedSource(value: unknown): AddressedSurfaceIntentSource | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!isRecord(value) || typeof value.input !== 'string' || value.input.length === 0) return null;
  return { input: value.input, ...(isRecord(value.params) ? { params: value.params } : {}) };
}

export function readAddressedSurfaceIntentRequest(value: unknown): AddressedSurfaceIntentRequest | null {
  if (!isRecord(value)) return null;
  const destinationRef = readString(value.destinationRef ?? value.destination_ref);
  const deliveryRef = readString(value.deliveryRef ?? value.delivery_ref);
  const source = readAddressedSource(value.source ?? value.source_selector);
  const intentPath = readPath(value.intentPath ?? value.intent_path);
  if (!destinationRef || !deliveryRef || !source || !intentPath) return null;
  const keyPath = readPath(value.keyPath ?? value.key_path);
  const rawRoutes = value.dispositionRoutes ?? value.disposition_routes;
  const dispositionRoutes = isRecord(rawRoutes) && Object.values(rawRoutes).every((route) => route === 'emit' || route === 'button')
    ? rawRoutes as Readonly<Record<string, 'emit' | 'button'>> : undefined;
  const rawDefaultRoute = value.defaultRoute ?? value.default_route;
  const defaultRoute = rawDefaultRoute === 'emit' || rawDefaultRoute === 'button' ? rawDefaultRoute : undefined;
  return { destinationRef, deliveryRef, source, intentPath, ...(keyPath ? { keyPath } : {}), ...(dispositionRoutes ? { dispositionRoutes } : {}), ...(defaultRoute ? { defaultRoute } : {}) };
}

export function readPlaceableSurfacePayloadFromUnknown(
  value: unknown,
): PlaceableSurfacePayload | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? readPayloadRecord(parsed) : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? readPayloadRecord(value) : null;
}

export function hasPlaceableSurface(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(PLACEABLE_SURFACE_MIME);
}

export function readPlaceableSurfacePayload(
  dataTransfer: DataTransfer,
): PlaceableSurfacePayload | null {
  if (!hasPlaceableSurface(dataTransfer)) return null;
  const raw = dataTransfer.getData(PLACEABLE_SURFACE_MIME);
  return raw ? readPlaceableSurfacePayloadFromUnknown(raw) : null;
}

export function setPlaceableSurfaceDragData(
  dataTransfer: DataTransfer,
  payload: PlaceableSurfacePayload,
  plainTextLabel: string,
): void {
  dataTransfer.setData(PLACEABLE_SURFACE_MIME, JSON.stringify(payload));
  dataTransfer.setData('text/plain', plainTextLabel);
  dataTransfer.effectAllowed = 'copyMove';
}

export function emitPlaceableSurfaceIntent(
  payload: PlaceableSurfacePayload,
): boolean {
  if (typeof window === 'undefined') return false;
  const event = new CustomEvent(PLACEABLE_SURFACE_MIME, {
    cancelable: true,
    detail: payload,
  });
  const accepted = !window.dispatchEvent(event);
  // The rail can paint before the arrangement mounts its event listener. Keep
  // that click in memory until the receiver attaches instead of losing it.
  if (!accepted) {
    const pending = pendingPlaceableSurfaceIntents();
    pending.push(payload);
    if (pending.length > 32) pending.shift();
  }
  return accepted;
}

/** Replay browser-local opens that arrived before a screen was ready to listen. */
export function replayPendingPlaceableSurfaceIntents(): void {
  if (typeof window === 'undefined') return;
  const pending = pendingPlaceableSurfaceIntents();
  while (pending.length > 0) {
    const payload = pending[0];
    const accepted = !window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, {
      cancelable: true,
      detail: payload,
    }));
    if (!accepted) break;
    pending.shift();
  }
}

export function emitPlaceableSurfaceCompleted(completionRef: string): boolean {
  if (typeof window === 'undefined' || typeof completionRef !== 'string' || !completionRef.trim()) return false;
  return window.dispatchEvent(new CustomEvent<PlaceableSurfaceCompletionDetail>(
    PLACEABLE_SURFACE_COMPLETED_EVENT,
    { detail: { completionRef: completionRef.trim() } },
  ));
}

/** Uses the same DOM event family as drag/drop and static intent emission. */
export function emitAddressedSurfaceIntentRequest(request: AddressedSurfaceIntentRequest): boolean {
  if (typeof window === 'undefined') return false;
  const event = new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: request });
  return !window.dispatchEvent(event);
}
