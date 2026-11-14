import * as React from 'react';

export const BROWSING_SURFACE_READY_EVENT = 'bitfield-browsing-surface-ready';

type UnknownRecord = Record<string, unknown>;

type BrowsingSurface = {
  mode?: string;
  elementTag?: string;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readBrowsingSurface(value: unknown): BrowsingSurface {
  if (!isRecord(value)) return {};
  return {
    mode: readString(value.mode),
    elementTag: readString(value.elementTag) ?? readString(value.element_tag),
  };
}

function currentBrowsingSurface(): unknown {
  return (globalThis as typeof globalThis & {
    __BITFIELD_BROWSING_SURFACE__?: unknown;
  }).__BITFIELD_BROWSING_SURFACE__;
}

function ruleMatches(rule: UnknownRecord, surface: BrowsingSurface): boolean {
  const expectedMode = readString(rule.mode);
  const expectedElementTag = readString(rule.element_tag) ?? readString(rule.elementTag);
  if (!expectedMode && !expectedElementTag) return false;
  if (expectedMode && expectedMode !== surface.mode) return false;
  if (expectedElementTag && expectedElementTag !== surface.elementTag) return false;
  return true;
}

/**
 * Resolves a DATA-authored value for the browsing surface that is presenting it.
 * Primitive values remain unchanged, so existing callers need no migration.
 */
export function resolveBrowsingSurfacePresentationValue(
  value: unknown,
  browsingSurface: unknown = currentBrowsingSurface(),
): unknown {
  if (!isRecord(value) || !Array.isArray(value.when_browsing_surface)) return value;

  const surface = readBrowsingSurface(browsingSurface);
  for (const candidate of value.when_browsing_surface) {
    if (!isRecord(candidate) || !ruleMatches(candidate, surface)) continue;
    if (Object.prototype.hasOwnProperty.call(candidate, 'value')) return candidate.value;
  }
  return value.default;
}

/**
 * Decodes an optional placeable-surface allowlist. `null`, `undefined`, and
 * every non-array value mean unrestricted. An explicit empty array means that
 * no catalog surface is visible.
 */
export function readVisiblePlaceableSurfaceIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map((candidate) => candidate.trim())
    .filter(Boolean))];
}

/** Keeps one shared catalog while changing only what this presentation offers. */
export function filterByVisiblePlaceableSurfaceIds<T extends { id: string }>(
  items: readonly T[],
  visibleSurfaceIds: readonly string[] | undefined,
): T[] {
  if (visibleSurfaceIds === undefined) return [...items];
  const allowed = new Set(visibleSurfaceIds);
  return items.filter((item) => allowed.has(item.id));
}

/**
 * Re-resolves after a native presenter installs its browsing-surface bridge.
 */
export function useBrowsingSurfacePresentationValue(value: unknown): unknown {
  const [surfaceRevision, setSurfaceRevision] = React.useState(0);

  React.useEffect(() => {
    const onReady = () => setSurfaceRevision((current) => current + 1);
    globalThis.addEventListener?.(BROWSING_SURFACE_READY_EVENT, onReady);
    return () => globalThis.removeEventListener?.(BROWSING_SURFACE_READY_EVENT, onReady);
  }, []);

  return React.useMemo(
    () => resolveBrowsingSurfacePresentationValue(value),
    [value, surfaceRevision],
  );
}
