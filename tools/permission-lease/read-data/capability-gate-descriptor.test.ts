import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { readCapabilityGateDescriptor, resolveCapabilityGate, type CapabilityGateDescriptor } from './capability-gate-descriptor.ts';
import { conditionPack } from './condition-node-pack.ts';
import type { CapabilityObligation, FactRecord } from './obligation-decision.ts';

const PACK = conditionPack;
const NOW = '2026-07-05T12:00:00Z';

const descriptor: CapabilityGateDescriptor = {
  capability_ref: 'capability:deep-work',
  guarded: { package_name: 'documents', entry_name: 'documents' },
};

const walk: CapabilityObligation = {
  obligation_ref: 'obl:walk',
  capability_ref: 'capability:deep-work',
  condition: { measure: 'measure.walk-attested-today', op: 'gte', value: 1 },
} as unknown as CapabilityObligation;

const hydrate: CapabilityObligation = {
  obligation_ref: 'obl:hydrate',
  capability_ref: 'capability:deep-work',
  condition: { measure: 'measure.water-logged-today', op: 'gte', value: 1 },
} as unknown as CapabilityObligation;

const otherCap: CapabilityObligation = {
  obligation_ref: 'obl:elsewhere',
  capability_ref: 'capability:spend-money',
  condition: { measure: 'measure.nope', op: 'gte', value: 1 },
} as unknown as CapabilityObligation;

// Canonical reduced measure: `{kind:'measure.fact', emit:<measureId>, value:<n>}`.
const fact = (measure: string, value: number): FactRecord =>
  ({ kind: 'measure.fact', emit: measure, value, recorded_at: NOW } as unknown as FactRecord);

describe('readCapabilityGateDescriptor', () => {
  it('parses a full descriptor from opaque surface_input', () => {
    const d = readCapabilityGateDescriptor({
      capability_ref: 'capability:deep-work',
      guarded: { package_name: 'p', entry_name: 'e', surface_input: { x: 1 } },
      locked_title: 'Work is paused',
    });
    expect(d).toMatchObject({ capability_ref: 'capability:deep-work', guarded: { package_name: 'p', entry_name: 'e', surface_input: { x: 1 } }, locked_title: 'Work is paused' });
  });

  it('fails closed (null) when capability_ref or guarded package/entry is missing', () => {
    expect(readCapabilityGateDescriptor(null)).toBeNull();
    expect(readCapabilityGateDescriptor({ guarded: { package_name: 'p', entry_name: 'e' } })).toBeNull();
    expect(readCapabilityGateDescriptor({ capability_ref: 'c', guarded: { package_name: 'p' } })).toBeNull();
  });
});

describe('resolveCapabilityGate — the structural decision', () => {
  it('WITHHOLDS the capability when a tracked obligation is unsatisfied, and reports it as blocking', () => {
    const view = resolveCapabilityGate(descriptor, [walk, hydrate, otherCap], [], NOW, PACK);
    expect(view.allowed).toBe(false);
    expect(view.blocking.map((o) => o.obligation_ref).sort()).toEqual(['obl:hydrate', 'obl:walk']);
    // obligations for OTHER capabilities never block this one.
    expect(view.blocking.some((o) => o.obligation_ref === 'obl:elsewhere')).toBe(false);
  });

  it('partially satisfied still WITHHELD; only the remaining obligation blocks', () => {
    const view = resolveCapabilityGate(descriptor, [walk, hydrate], [fact('measure.walk-attested-today', 1)], NOW, PACK);
    expect(view.allowed).toBe(false);
    expect(view.blocking.map((o) => o.obligation_ref)).toEqual(['obl:hydrate']);
  });

  it('UNLOCKS the capability once every tracked obligation is satisfied', () => {
    const view = resolveCapabilityGate(
      descriptor,
      [walk, hydrate],
      [fact('measure.walk-attested-today', 1), fact('measure.water-logged-today', 1)],
      NOW,
      PACK,
    );
    expect(view.allowed).toBe(true);
    expect(view.blocking).toEqual([]);
  });

  it('a capability with no obligations is allowed (nothing is owed)', () => {
    const view = resolveCapabilityGate(descriptor, [otherCap], [], NOW, PACK);
    expect(view.allowed).toBe(true);
    expect(view.blocking).toEqual([]);
  });
});
