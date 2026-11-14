import { buildApplicationSurfaceCatalogContribution } from '../read-data/application-surface-catalog-contribution';

type Plain = Record<string, unknown>;

function plain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function prepared(input: unknown) {
  const result = buildApplicationSurfaceCatalogContribution(input) as {
    write_set: {
      upserts: Array<{ type?: unknown; address?: unknown; payload?: unknown }>;
      retractions: Array<{ type?: unknown; address?: unknown; remove?: unknown }>;
    };
  };
  const direct = [...result.write_set.upserts, ...result.write_set.retractions]
    .find((write) => write.type === 'record');
  if (direct) {
    if (typeof direct.address !== 'string') throw new Error('catalog companion preparation has no destination');
    const retract = direct.remove === true;
    if (!retract && !Object.hasOwn(direct, 'payload')) {
      throw new Error('catalog companion preparation has no payload');
    }
    if (!plain(input) || !plain(input.config)) {
      throw new Error('catalog companion preparation has no derived identity');
    }
    const catalogAddress = input.config.address_label;
    if (typeof catalogAddress !== 'string' || catalogAddress.length === 0) {
      throw new Error('catalog companion preparation has no catalog address');
    }
    return {
      kind: 'package-target-prepared-write',
      policy: 'replace',
      record_address: direct.address,
      derivation: 'application-surface-input-overrides',
      address_variables: { catalog_address: catalogAddress },
      path_labels: [],
      ...(retract ? { retract: true } : { payload: direct.payload }),
    };
  }
  const materialized = result.write_set.upserts[0] ?? result.write_set.retractions[0];
  if (typeof materialized?.address !== 'string') throw new Error('catalog preparation has no destination');
  return { kind: 'package-target-compiler-materialized-readback', address_label: materialized.address };
}

export function buildApplicationSurfaceCatalogContributionTarget(input: unknown, _context?: unknown) {
  if (!plain(input) || input.intent !== 'apply') return prepared(input);
  const value = input.prepared;
  if (
    !plain(value)
    || typeof value.record_address !== 'string'
    || value.derivation !== 'application-surface-input-overrides'
    || !plain(value.address_variables)
    || !Array.isArray(value.path_labels)
  ) {
    throw new Error('apply requires prepared catalog companion identity');
  }
  return {
    kind: 'package-target-write-envelope',
    response: { kind: 'write-accepted-for-readback', prepared: value },
    writes: [{
      record_address: value.record_address,
      derivation: value.derivation,
      address_variables: value.address_variables,
      path_labels: value.path_labels,
      ...(value.retract === true ? { retract: true } : { payload: value.payload }),
      expected_current: input.expected_current,
    }],
  };
}
