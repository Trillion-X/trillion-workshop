// Proves the lock-surface descriptor is N-state and 100% DATA-driven (L063/L090):
// no binary locked/unlocked assumption, no example-specific icons in code.

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { deriveLockSurfaceDescriptor } from './lock-surface-descriptor.ts';
import { conditionNodes, predicateOps } from './condition-node-pack.ts';
import type { CapabilityObligation, FactRecord } from './obligation-decision.ts';

const PACK = { nodes: conditionNodes, predicates: predicateOps };
const NOW = '2026-07-03T12:00:00.000Z';

function fact(kind: string, value: number): FactRecord {
  return { kind, value, recorded_at: NOW } as FactRecord;
}

const walkGate = {
  kind: 'capability-obligation',
  obligation_ref: 'obl:walk',
  capability_ref: 'capability:deep-work',
  locked_title: 'Log a walk to continue',
  unlocked_title: "You're clear",
  progress_measure: 'measure.walk-count-today',
  progress_required: 1,
  unlock_action_label: 'I took my walk',
  unlock_action_icon: 'Footprints',
  condition: { measure: 'measure.walk-count-today', op: 'gte', value: 1 },
  satisfy: {
    fact: { kind: 'activity.attestation', fields: { activity: 'walk' } },
    recompute: [
      {
        measure_id: 'measure:wholeness.walk-count-today',
        fact_where: [
          { field: 'kind', in: ['activity.attestation'] },
          { field: 'day', in: ['$today'] },
        ],
      },
    ],
  },
} as unknown as CapabilityObligation;

describe('lock-surface descriptor — DATA-driven, N-state', () => {
  it('degenerate 2-state: LOCKED with default icon/tone when the fact is missing', () => {
    const d = deriveLockSurfaceDescriptor(walkGate, [], NOW, PACK);
    expect(d.state).toBe('locked');
    expect(d.iconName).toBe('Lock');
    expect(d.tone).toBe('warning');
    expect(d.title).toBe('Log a walk to continue');
    expect(d.progress).toEqual({ have: 0, required: 1, caption: '0 of 1' });
    // action icon + label come from DATA, not hardcoded in code
    expect(d.action?.iconName).toBe('Footprints');
    expect(d.action?.label).toBe('I took my walk');
    // action carries the obligation's `satisfy` DATA — the evidence fact to record
    // + the reduce spec — NOT a bare measure to fabricate (the facade is gone).
    expect(d.action?.satisfy.fact.kind).toBe('activity.attestation');
    expect(d.action?.satisfy.recompute[0].measure_id).toBe('measure:wholeness.walk-count-today');
  });

  it('FAIL CLOSED: no satisfy DATA => no action button (cannot fabricate a measure)', () => {
    const { satisfy: _omit, ...noSatisfy } = walkGate as unknown as Record<string, unknown>;
    const d = deriveLockSurfaceDescriptor(noSatisfy as unknown as CapabilityObligation, [], NOW, PACK);
    expect(d.state).toBe('locked');
    expect(d.progress).toEqual({ have: 0, required: 1, caption: '0 of 1' });
    expect(d.action).toBeUndefined();
  });

  it('degenerate 2-state: UNLOCKED with default success icon when the fact satisfies', () => {
    const d = deriveLockSurfaceDescriptor(walkGate, [fact('measure.walk-count-today', 1)], NOW, PACK);
    expect(d.state).toBe('unlocked');
    expect(d.iconName).toBe('CheckCircle2');
    expect(d.tone).toBe('success');
    expect(d.progress).toBeUndefined();
    expect(d.action).toBeUndefined();
  });

  // The LIVE wholeness-walk config (data/wholeness-walk-obligation.json): the condition
  // is wrapped in `any`, carries `within_ms` daily freshness, and the satisfied measure
  // arrives in the CANONICAL progression-evaluator shape {kind:'measure.fact', emit:<m>}.
  // These guard the exact production shape the earlier tests skipped (they used a bare
  // condition + bare-kind fact) — the shape the "3 of 1 but still locked" bug lives in.
  const liveWalkGate = {
    ...walkGate,
    condition: { any: [{ measure: 'measure.walk-count-today', op: 'gte', value: 1, within_ms: 86400000 }] },
  } as unknown as CapabilityObligation;

  // The canonical reduced fact progression-evaluator writes (NOT the bare-kind shape).
  const measureFact = (value: number, recordedAt: string): FactRecord =>
    ({ kind: 'measure.fact', emit: 'measure.walk-count-today', value, recorded_at: recordedAt } as unknown as FactRecord);

  it('UNLOCKS on a FRESH canonical measure.fact through the `any`+within_ms path (the real config)', () => {
    // A walk logged today (value 3 >= required 1), stamped now → inside the 24h window.
    const d = deriveLockSurfaceDescriptor(liveWalkGate, [measureFact(3, NOW)], NOW, PACK);
    expect(d.state).toBe('unlocked');
    expect(d.tone).toBe('success');
    expect(d.progress).toBeUndefined();
    expect(d.action).toBeUndefined();
  });

  it('STALE measure reads "0 of 1" (SSOT: progress agrees with the freshness-aware decision, not "3 of 1")', () => {
    // Same value (3) but recorded_at is 2 days old → outside within_ms. The DECISION
    // locks (stale), and now the PROGRESS agrees: a stale prior-day count is 0 fresh
    // progress today, so the caption is an honest "0 of 1" — NOT the contradictory
    // "3 of 1 but locked" the user reported. One freshness-aware read feeds both.
    const twoDaysAgo = '2026-07-01T12:00:00.000Z';
    const d = deriveLockSurfaceDescriptor(liveWalkGate, [measureFact(3, twoDaysAgo)], NOW, PACK);
    expect(d.state).toBe('locked');
    expect(d.progress).toEqual({ have: 0, required: 1, caption: '0 of 1' });
  });

  it('N-state via DATA state_ladder + presentation (no code branch per state)', () => {
    const masteryGate = {
      kind: 'capability-obligation',
      obligation_ref: 'obl:mastery',
      capability_ref: 'capability:advance-lesson-2',
      progress_measure: 'measure.recall-score',
      progress_required: 0.8,
      condition: { measure: 'measure.recall-score', op: 'gte', value: 0.8 },
      state_ladder: [
        { state: 'locked', min: 0 },
        { state: 'in-progress', min: 0.4 },
        { state: 'mastered', min: 0.8 },
      ],
      presentation: {
        'in-progress': { icon: 'TrendingUp', tone: 'info', label: 'In progress' },
        mastered: { icon: 'Award', tone: 'success', label: 'Mastered' },
      },
      'in-progress_title': 'Getting there',
      mastered_title: 'Lesson mastered',
    } as unknown as CapabilityObligation;

    expect(deriveLockSurfaceDescriptor(masteryGate, [fact('measure.recall-score', 0.2)], NOW, PACK).state).toBe('locked');

    const mid = deriveLockSurfaceDescriptor(masteryGate, [fact('measure.recall-score', 0.5)], NOW, PACK);
    expect(mid.state).toBe('in-progress');
    expect(mid.iconName).toBe('TrendingUp');
    expect(mid.tone).toBe('info');
    expect(mid.stateLabel).toBe('In progress');
    expect(mid.title).toBe('Getting there');

    const top = deriveLockSurfaceDescriptor(masteryGate, [fact('measure.recall-score', 0.9)], NOW, PACK);
    expect(top.state).toBe('mastered');
    expect(top.iconName).toBe('Award');
    expect(top.title).toBe('Lesson mastered');
  });
});
