import { buildApplicationWalkthroughContribution } from '../read-data/application-walkthrough-contribution.ts';

type Plain = Record<string, unknown>;
function plain(value: unknown): value is Plain { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, path: string) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(path + ' must be a non-empty string');
  return value;
}
function prepared(input: unknown) {
  const result = buildApplicationWalkthroughContribution(input) as { write_set: { upserts: Plain[]; retractions: Plain[] } };
  const write = result.write_set.upserts[0] ?? result.write_set.retractions[0];
  if (!write || typeof write.address !== 'string' || write.type !== 'record') throw new Error('walkthrough preparation is not a direct record');
  if (!plain(input) || !plain(input.config) || !plain(input.config.definition) || !Array.isArray(write.path) || !write.path.every((label) => typeof label === 'string' && label.length > 0)) {
    throw new Error('walkthrough preparation has no derived identity or owner path');
  }
  return {
    kind: 'package-target-prepared-write',
    policy: 'replace',
    record_address: write.address,
    derivation: 'application-walkthrough-definition',
    address_variables: {
      composition_id: text(input.composition_id, 'composition_id'),
      definition_id: text(input.config.definition.id, 'config.definition.id'),
    },
    path_labels: write.path,
    payload: write.remove ? undefined : write.payload,
    retract: write.remove === true,
  };
}
export function buildApplicationWalkthroughContributionTarget(input: unknown, _context?: unknown) {
  if (!plain(input) || input.intent !== 'apply') return prepared(input);
  const value = input.prepared;
  if (!plain(value) || typeof value.record_address !== 'string' || value.derivation !== 'application-walkthrough-definition' || !plain(value.address_variables) || !Array.isArray(value.path_labels)) {
    throw new Error('apply requires prepared walkthrough destination');
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
