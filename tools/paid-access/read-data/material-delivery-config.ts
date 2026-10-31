// tools/paid-access/read-data/material-delivery-config.ts
//
// Generic, DATA-overridable configuration for the private-object delivery primitive.
// Every value has a MAXIMALLY CAPABLE default: with ZERO config the primitive works against
// the conventional address. The door that serves paid files sends its own `delivery_config`
// (its route base path, its default lease length) with the request; nothing is recompiled.
//
// Nothing here is product/society-specific: a route base path and a default TTL.
// (Changed from the package: the old engine's runtime partition and object-store-map address
// are gone, because the map rows are now the person's `paid-file` records read through the
// records door.)

export type MaterialDeliveryConfig = {
  /** Base path of the guarded byte route the delivery URL points at. */
  deliveryBasePath: string;
  /** Lease lifetime used when an object row does not specify its own. */
  defaultTtlSeconds: number;
};

const DEFAULTS: MaterialDeliveryConfig = {
  deliveryBasePath: '/private-material',
  defaultTtlSeconds: 3600,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function posInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Resolve config from the given data (looks for a `material-delivery-config`
 * object, by that key or as the object itself), falling back to capable defaults for
 * every missing field. Pure.
 */
export function readMaterialDeliveryConfig(packageData?: unknown): MaterialDeliveryConfig {
  const root = isRecord(packageData) ? packageData : {};
  const cfg = isRecord(root['material-delivery-config'])
    ? (root['material-delivery-config'] as Record<string, unknown>)
    : isRecord(root.materialDeliveryConfig)
      ? (root.materialDeliveryConfig as Record<string, unknown>)
      : root;
  return {
    deliveryBasePath: str(cfg.delivery_base_path ?? cfg.deliveryBasePath, DEFAULTS.deliveryBasePath),
    defaultTtlSeconds: posInt(cfg.default_ttl_seconds ?? cfg.defaultTtlSeconds, DEFAULTS.defaultTtlSeconds),
  };
}
