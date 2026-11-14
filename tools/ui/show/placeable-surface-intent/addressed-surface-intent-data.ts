import type { SurfaceIntentReaderProps } from './surface-intent-reader';
import type { AddressedSurfaceIntentSource } from './placeable-surface-intent';

export const ADDRESSED_SURFACE_INTENT_INPUT = 'selector-source-by-address-label';

export type SurfaceIntentReaderConfig = Readonly<{
  source: AddressedSurfaceIntentSource;
  intentPath: readonly string[];
  keyPath?: readonly string[];
  dispositionRoutes?: Readonly<Record<string, 'emit' | 'button'>>;
  defaultRoute?: 'emit' | 'button';
}>;

export type AddressedSurfaceIntentReaderProps = Omit<SurfaceIntentReaderProps, 'records'> & {
  readonly source: AddressedSurfaceIntentSource;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringPath(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0) ? value : null;
}

/** Decode generic mount DATA once. No domain/result/address semantics live here. */
export function readSurfaceIntentReaderConfig(value: unknown): SurfaceIntentReaderConfig | null {
  if (!isRecord(value)) return null;
  const rawSource = value.source ?? value.source_selector;
  const source = rawSource === ADDRESSED_SURFACE_INTENT_INPUT
    ? ADDRESSED_SURFACE_INTENT_INPUT
    : isRecord(rawSource) && rawSource.input === ADDRESSED_SURFACE_INTENT_INPUT
      ? { input: ADDRESSED_SURFACE_INTENT_INPUT, ...(isRecord(rawSource.params) ? { params: rawSource.params } : {}) }
      : null;
  const intentPath = stringPath(value.intentPath ?? value.intent_path);
  if (!source || !intentPath) return null;
  const keyPath = stringPath(value.keyPath ?? value.key_path);
  const rawRoutes = value.dispositionRoutes ?? value.disposition_routes;
  const routes = isRecord(rawRoutes) && Object.values(rawRoutes).every((entry) => entry === 'emit' || entry === 'button')
    ? rawRoutes as Readonly<Record<string, 'emit' | 'button'>>
    : undefined;
  const rawDefaultRoute = value.defaultRoute ?? value.default_route;
  const defaultRoute = rawDefaultRoute === 'emit' || rawDefaultRoute === 'button' ? rawDefaultRoute : undefined;
  return { source, intentPath, ...(keyPath ? { keyPath } : {}), ...(routes ? { dispositionRoutes: routes } : {}), ...(defaultRoute ? { defaultRoute } : {}) };
}

/** Normalize current-item selector shapes into SurfaceIntentReader records. */
export function normalizeAddressedSurfaceIntentRecords(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ['records', 'items', 'payload', 'value']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [value];
}
