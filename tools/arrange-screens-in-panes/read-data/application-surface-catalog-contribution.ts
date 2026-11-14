// screen-arrangement-owned contribution for a maintained placeable-surface
// catalog. The placement label is DATA; one generic fold serves every workspace.

type Plain = Record<string, unknown>;

const OWNER_REF = 'package::screen-arrangement::application-contribution::placeable-surface-catalog';

function plain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function surfaceInputOverrides(value: unknown): Array<{ surface_id: string; surface_input: Plain }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('config.surface_input_overrides must be an array');
  return value.map((entry, index) => {
    if (!plain(entry)) throw new Error(`config.surface_input_overrides[${index}] must be an object`);
    if (!plain(entry.surface_input)) {
      throw new Error(`config.surface_input_overrides[${index}].surface_input must be an object`);
    }
    return {
      surface_id: text(entry.surface_id, `config.surface_input_overrides[${index}].surface_id`),
      surface_input: entry.surface_input,
    };
  });
}

// WHAT AN APPLICATION IS OFFERING IS NOT WHAT IT CAN PLACE, and the catalog is
// only the first of those. The fold below matches EVERY published
// `placeable-surface` carrying the placement label, which is the right default:
// a package contributes a surface and it becomes reachable without anyone
// editing a list. An application that deliberately presents a narrow product
// then has exactly one honest move available to it, which is to stop the
// surfaces being contributed at all, and that is the wrong move: it is an edit
// in every contributing package (92 of them here), it is an application's
// preference written into shared packages, and it destroys the thing the
// application still wants, because the surface has to keep existing for the
// application to open it deliberately later.
//
// So narrowing belongs HERE, on the catalog, as DATA. These predicates are
// appended to the fold's own match, which means a narrowed catalog and a full
// one are the same code path with different rows, and a surface left out of the
// catalog is still published, still addressable, and still placeable by
// anything that asks for it by id.
//
// The predicates are passed through UNREAD. This file does not know `in` from
// `equals` and must not: the operator vocabulary belongs to the matcher that
// evaluates it, and a copy of that list here would be a second place to update
// the day it grows. What IS enforced is one operator per predicate, because the
// runtime matcher evaluates the first set operator and IGNORES the rest, so a
// two-operator predicate silently drops a condition. Silently dropping a
// condition on the surfaces a product offers is how a restricted product quietly
// stops being restricted, which is the one failure worth a hard refusal here.
function onlySurfacesMatching(value: unknown): Plain[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('config.only_surfaces_matching must be an array');
  return value.map((entry, index) => {
    const at = `config.only_surfaces_matching[${index}]`;
    if (!plain(entry)) throw new Error(`${at} must be an object`);
    if (!Array.isArray(entry.path) || entry.path.length === 0) {
      throw new Error(`${at}.path must be a non-empty array`);
    }
    entry.path.forEach((segment, segmentIndex) => text(segment, `${at}.path[${segmentIndex}]`));
    const operators = Object.keys(entry).filter((key) => key !== 'path');
    if (operators.length !== 1) {
      throw new Error(
        `${at} must declare exactly one operator beside path, and declares ${operators.length}`,
      );
    }
    return entry;
  });
}

export function surfaceInputOverridesAddress(catalogAddress: string): string {
  return `package::screen-arrangement::placeable-surface-input-overrides::${encodeURIComponent(catalogAddress)}`;
}

export function buildApplicationSurfaceCatalogContribution(input: unknown) {
  if (!plain(input)) throw new Error('contribution operation must be an object');
  if (input.owner_ref !== OWNER_REF) throw new Error(`owner_ref must be ${OWNER_REF}`);
  if (input.operation !== 'upsert' && input.operation !== 'retract') throw new Error('operation must be upsert or retract');
  if (!plain(input.config)) throw new Error('config must be an object');
  const address = text(input.config.address_label, 'config.address_label');
  const overridesAddress = surfaceInputOverridesAddress(address);
  if (input.operation === 'retract') {
    return {
      schema: 'screen-arrangement.application-surface-catalog-contribution/placement-filtered-write-set',
      write_set: {
        upserts: [],
        retractions: [
          { type: 'record_from_matching_records', address, path: [], remove: true },
          { type: 'record', address: overridesAddress, path: [], remove: true },
        ],
      },
    };
  }
  const placementLabel = input.config.placement_label === undefined
    ? undefined
    : text(input.config.placement_label, 'config.placement_label');
  const overrides = surfaceInputOverrides(input.config.surface_input_overrides);
  const narrowing = onlySurfacesMatching(input.config.only_surfaces_matching);
  return {
    schema: 'screen-arrangement.application-surface-catalog-contribution/placement-filtered-write-set',
    write_set: {
      upserts: [{
        type: 'record_from_matching_records',
        address,
        path: [],
        matching_record_paths: [['current-item', 'published-record']],
        payload_bytes: {
          value_to_bytes: 'json_array',
          rows: {
            source: { path: ['payload'] },
            match: [
              { path: ['payload', 'kind'], equals: 'placeable-surface' },
              ...(placementLabel
                ? [{ path: ['payload', 'placement_labels'], contains: placementLabel }]
                : []),
              ...narrowing,
            ],
            order_by: [{
              source: { path: ['payload', 'placement_order_key'] },
              value: { value_to_bytes: 'non_empty_text' },
            }],
          },
        },
      }, ...(overrides.length > 0 ? [{
        type: 'record',
        address: overridesAddress,
        path: [],
        payload: {
          schema: 'screen-arrangement.placeable-surface-input-overrides/v1',
          surface_input_overrides: overrides,
        },
      }] : [])],
      retractions: overrides.length === 0
        ? [{ type: 'record', address: overridesAddress, path: [], remove: true }]
        : [],
    },
  };
}
