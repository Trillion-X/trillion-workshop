import { buildGroupBoardSurfaceContribution } from '../read-data/application-board-surface-contribution.ts';

type Plain = Record<string, unknown>;
function plain(value: unknown): value is Plain { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, path: string) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(path + ' must be a non-empty string');
  return value;
}
function prepared(input: unknown) {
  const result = buildGroupBoardSurfaceContribution(input) as { write_set: { upserts: Plain[]; retractions: Plain[] } };
  const write = result.write_set.upserts[0] ?? result.write_set.retractions[0];
  if (!write || typeof write.address !== 'string' || write.type !== 'record') throw new Error('board preparation is not a direct record');
  if (!plain(input) || !plain(input.config) || !Array.isArray(write.path) || !write.path.every((label) => typeof label === 'string' && label.length > 0)) {
    throw new Error('board preparation has no derived identity or owner path');
  }
  return {
    kind: 'package-target-prepared-write',
    policy: 'replace',
    record_address: write.address,
    derivation: 'application-board-surface',
    address_variables: {
      composition_id: text(input.composition_id, 'composition_id'),
      surface_id: text(input.config.surface_id, 'config.surface_id'),
    },
    path_labels: write.path,
    payload: write.remove ? undefined : write.payload,
    retract: write.remove === true,
  };
}
export function buildApplicationBoardSurfaceContributionTarget(input: unknown, _context?: unknown) {
  if (!plain(input) || input.intent !== 'apply') return prepared(input);
  const value = input.prepared;
  if (!plain(value) || typeof value.record_address !== 'string' || value.derivation !== 'application-board-surface' || !plain(value.address_variables) || !Array.isArray(value.path_labels)) {
    throw new Error('apply requires prepared board destination');
  }
  return {
    kind: 'package-target-write-envelope',
    response: { kind: 'write-accepted-for-readback', prepared: value },
    writes: [{
      record_address: value.record_address,
      derivation: value.derivation,
      address_variables: value.address_variables,
      path_labels: value.path_labels,
      payload: value.payload,
      retract: value.retract === true,
      expected_current: input.expected_current,
    }],
  };
}
