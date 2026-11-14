import { buildApplicationLayoutStateContribution } from '../read-data/application-layout-state-contribution';
import { defaultLayoutState } from '../read-data/read-screen-arrangement';

type Plain = Record<string, unknown>;

function plain(value: unknown): value is Plain { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function prepared(input: unknown) {
  const result = buildApplicationLayoutStateContribution(input) as { write_set: { upserts: Plain[]; retractions: Plain[] } };
  const write = result.write_set.upserts[0] ?? result.write_set.retractions[0];
  if (!write || typeof write.address !== 'string') throw new Error('layout preparation has no destination');
  if (write.type !== 'record') throw new Error('layout preparation is not a direct record');
  return { kind: 'package-target-prepared-write', policy: 'seed-only', record_address: write.address,
    payload: write.remove ? undefined : write.payload, retract: write.remove === true,
    // A fresh install already contains Screen's own empty bootstrap seed. It is
    // safe to replace only that exact value with the application's default;
    // every user-authored or previously selected layout remains preserved.
    replace_if_current_payload: write.remove ? undefined : defaultLayoutState() };
}

export function buildApplicationLayoutStateContributionTarget(input: unknown, _context?: unknown) {
  if (!plain(input) || input.intent !== 'apply') return prepared(input);
  const value = input.prepared;
  if (!plain(value) || typeof value.record_address !== 'string') throw new Error('apply requires prepared layout record identity');
  return { kind: 'package-target-write-envelope', response: { kind: 'write-accepted-for-readback', prepared: value }, writes: [{
    record_address: value.record_address, payload: value.payload, retract: value.retract === true,
    expected_current: input.expected_current,
  }] };
}
