// packages/permission-lease/read-data/capability-gate-descriptor.ts
//
// The STRUCTURAL capability gate — pure resolution of "is this capability
// available, and if not, what is blocking it". This is what turns the gate from
// WORDS (a card that says locked/unlocked) into a real LOCK: a capability's
// guarded content (a target surface) is only rendered when the tracked facts
// satisfy its obligations. "I'm not unlocking anything until the tracked fact
// exists" — enforced by structure, not copy.
//
// Everything is DATA: which capability, which guarded surface, the locked copy —
// a `capability-gate` descriptor. The decision reuses the SAME pure decideCapability
// leaf over the SAME canonical measure.facts the gate cards read. Deletion test:
// gate a completely different capability behind a completely different taxonomy —
// zero code change, one descriptor row.

import {
  decideCapability,
  type CapabilityObligation,
  type CapabilityDecision,
  type FactRecord,
  type ConditionPack,
} from './obligation-decision.ts';

// Where the guarded content lives — a placeable surface embedded by the host
// when (and only when) the capability is allowed.
export interface GuardedSurface {
  readonly package_name: string;
  readonly entry_name: string;
  readonly surface_input?: Record<string, unknown>;
}

// A self-describing structural gate: capability + its guarded surface + the copy
// shown while locked. All DATA (from a surface's `surface_input` or a published
// `capability-gate` record).
export interface CapabilityGateDescriptor {
  readonly capability_ref: string;
  readonly guarded: GuardedSurface;
  readonly locked_title?: string;
  readonly locked_subtitle?: string;
}

export const CAPABILITY_GATE_KIND = 'capability-gate';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Parse a descriptor from an opaque source (surface_input or a record payload).
// Returns null when the shape is not a usable gate (fail-closed: no descriptor =
// the host shows nothing rather than silently un-gating).
export function readCapabilityGateDescriptor(source: unknown): CapabilityGateDescriptor | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  const capabilityRef = str(s.capability_ref);
  const guardedRaw = s.guarded && typeof s.guarded === 'object' ? (s.guarded as Record<string, unknown>) : null;
  if (!capabilityRef || !guardedRaw) return null;
  const packageName = str(guardedRaw.package_name);
  const entryName = str(guardedRaw.entry_name);
  if (!packageName || !entryName) return null;
  return {
    capability_ref: capabilityRef,
    guarded: {
      package_name: packageName,
      entry_name: entryName,
      ...(guardedRaw.surface_input && typeof guardedRaw.surface_input === 'object'
        ? { surface_input: guardedRaw.surface_input as Record<string, unknown> }
        : {}),
    },
    ...(str(s.locked_title) ? { locked_title: str(s.locked_title) } : {}),
    ...(str(s.locked_subtitle) ? { locked_subtitle: str(s.locked_subtitle) } : {}),
  };
}

export interface CapabilityGateView {
  readonly allowed: boolean;
  // The obligations for THIS capability that are not yet satisfied — what the
  // person must do (as tracked facts) before the guarded surface unlocks.
  readonly blocking: CapabilityObligation[];
  readonly decision: CapabilityDecision;
}

// Decide whether the capability's guarded surface is available, and if not, which
// obligations block it. Pure — reuses decideCapability (which itself filters to
// the capability) over the canonical measure.facts.
export function resolveCapabilityGate(
  descriptor: CapabilityGateDescriptor,
  obligations: readonly CapabilityObligation[],
  facts: readonly FactRecord[],
  nowIso: string,
  pack: ConditionPack,
): CapabilityGateView {
  const decision = decideCapability(descriptor.capability_ref, obligations, facts, nowIso, pack);
  const unsatisfied = new Set(decision.verdicts.filter((v) => !v.satisfied).map((v) => v.obligation_ref));
  const blocking = obligations.filter(
    (o) => o.capability_ref === descriptor.capability_ref && unsatisfied.has(o.obligation_ref),
  );
  return { allowed: decision.allowed, blocking, decision };
}
