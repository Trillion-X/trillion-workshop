import {
  emitPlaceableSurfaceIntent,
  type PlaceableSurfacePayload,
} from './placeable-surface-intent';
import type {
  EntryContextMatcher,
  PlaceableSurfaceRecord,
} from './placeable-surface-record';
import { offerableSurfaces } from './placeable-surface-record';
import { hostWithin } from 'trillion-workshop/tools/http-client/do-work/same-origin.mjs';

export interface EntryContext {
  readonly host?: string | null;
  readonly path?: string | null;
  readonly query?: Record<string, unknown> | URLSearchParams | string | null;
  readonly search?: string | null;
}

function normalizeHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '');
  return normalized.length > 0 ? normalized : null;
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function queryFromSearch(value: string): Record<string, string> {
  const params = new URLSearchParams(value.startsWith('?') ? value.slice(1) : value);
  return queryFromUrlSearchParams(params);
}

function queryFromUrlSearchParams(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key.trim()) result[key.trim()] = value;
  }
  return result;
}

function normalizeQuery(value: EntryContext['query'], search: EntryContext['search']): Record<string, string> {
  if (value instanceof URLSearchParams) return queryFromUrlSearchParams(value);
  if (typeof value === 'string') return queryFromSearch(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!key.trim()) continue;
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
        result[key.trim()] = String(entry);
      }
    }
    return result;
  }
  return typeof search === 'string' ? queryFromSearch(search) : {};
}

export function readEntryContextFromLocation(location: Pick<Location, 'host' | 'hostname' | 'pathname' | 'search'>): EntryContext {
  return {
    host: normalizeHost(location.hostname) ?? normalizeHost(location.host),
    path: normalizePath(location.pathname),
    query: queryFromSearch(location.search),
  };
}

function stringListMatchesExact(values: readonly string[], candidate: string | null): boolean {
  return !!candidate && values.some((value) => value.trim() === candidate);
}

function hostSuffixMatches(values: readonly string[], host: string | null): boolean {
  if (!host) return false;
  return values.some((value) => hostWithin(host, value));
}

function pathPrefixMatches(values: readonly string[], path: string | null): boolean {
  if (!path) return false;
  return values.some((value) => {
    const prefix = normalizePath(value);
    return !!prefix && (path === prefix || path.startsWith(prefix));
  });
}

function queryMatches(expected: Record<string, string>, actual: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export function entryContextMatchesMatcher(context: EntryContext, matcher: EntryContextMatcher): boolean {
  const host = normalizeHost(context.host);
  const path = normalizePath(context.path);
  const query = normalizeQuery(context.query, context.search);

  if (matcher.hosts.length > 0 && !stringListMatchesExact(matcher.hosts.map((value) => normalizeHost(value) ?? value), host)) return false;
  if (matcher.hostSuffixes.length > 0 && !hostSuffixMatches(matcher.hostSuffixes, host)) return false;
  if (matcher.paths.length > 0 && !stringListMatchesExact(matcher.paths, path)) return false;
  if (matcher.pathPrefixes.length > 0 && !pathPrefixMatches(matcher.pathPrefixes, path)) return false;
  return queryMatches(matcher.query, query);
}

function surfaceRouteMatchesEntryContext(surface: PlaceableSurfaceRecord, context: EntryContext): boolean {
  const path = normalizePath(context.path);
  return stringListMatchesExact(surface.routePaths, path)
    || pathPrefixMatches(surface.routePrefixes, path);
}

export function placeableSurfaceMatchesEntryContext(
  surface: PlaceableSurfaceRecord,
  context: EntryContext,
): boolean {
  if (surface.disabled) return false;
  if (surface.entryContexts?.some((matcher) => entryContextMatchesMatcher(context, matcher))) return true;
  return surfaceRouteMatchesEntryContext(surface, context);
}

export function findPlaceableSurfaceForEntryContext(
  surfaces: readonly PlaceableSurfaceRecord[],
  context: EntryContext,
): PlaceableSurfaceRecord | null {
  return surfaces.find((surface) => placeableSurfaceMatchesEntryContext(surface, context)) ?? null;
}

export function placeableSurfacePayloadFromRecord(surface: PlaceableSurfaceRecord): PlaceableSurfacePayload {
  return {
    id: surface.id,
    title: surface.label,
    target: surface.target ?? null,
    packageEntry: surface.packageEntry ?? null,
    materialTarget: surface.materialTarget,
    icon: surface.icon,
    ...(surface.surfaceInput ? { surfaceInput: surface.surfaceInput } : {}),
  };
}

/**
 * The shared presentation catalog for any owner that can mount a placeable
 * surface. `heldAccessRefs` only controls offer eligibility/defense in depth;
 * it is not buyer purchase authorization (Product Access + Hosted closure own
 * that authority). Disabled rows are revoked and therefore absent even for the
 * Studio owner.
 */
export function placeableSurfaceCatalogForViewer(
  surfaces: readonly PlaceableSurfaceRecord[],
  heldAccessRefs: readonly string[] | undefined,
): PlaceableSurfacePayload[] {
  return offerableSurfaces(surfaces, heldAccessRefs)
    .filter((surface) => !surface.disabled)
    .map(placeableSurfacePayloadFromRecord);
}

export function placeableSurfacePayloadForEntryContext(
  surfaces: readonly PlaceableSurfaceRecord[],
  context: EntryContext,
): PlaceableSurfacePayload | null {
  const surface = findPlaceableSurfaceForEntryContext(surfaces, context);
  return surface ? placeableSurfacePayloadFromRecord(surface) : null;
}

export function emitPlaceableSurfaceForEntryContext(
  surfaces: readonly PlaceableSurfaceRecord[],
  context: EntryContext,
): boolean {
  const payload = placeableSurfacePayloadForEntryContext(surfaces, context);
  return payload ? emitPlaceableSurfaceIntent(payload) : false;
}
