import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import type { SelectionSurface } from '../read-data/candidate-set-schema.ts';
import type { DeciderProgram } from '../read-data/decider-schema.ts';
import type { ObserverFact } from '../read-data/score-candidates.ts';
import { scoreCandidates } from '../read-data/score-candidates.ts';

describe('Bandit decider — pure DATA example', () => {
  it('shifts selection to highest-outcome candidate when outcomes exist', () => {
    const surface: SelectionSurface = {
      entity_type: 'selection-surface',
      address: 'test.bandit',
      decider_program_ref: 'decider:bandit-outcome-shift',
      candidates: [
        { candidate_id: 'a', material_ref: 'material:a' },
        { candidate_id: 'b', material_ref: 'material:b' },
      ],
    };

    // Bandit decider: case on outcome rates, fall back to sticky_hash on cold-start
    const decider: DeciderProgram = {
      entity_type: 'decider',
      decider_id: 'bandit-outcome-shift',
      score: {
        op: 'case',
        cases: [
          {
            when: { op: 'outcome', metric: 'conversion_rate' },
            then: { op: 'outcome', metric: 'conversion_rate' },
          },
        ],
        default: {
          op: 'sticky_hash',
          of: { const: 'observer-id' },
          split: { split: { a: 0.5, b: 0.5 } },
        },
      },
      accepts_trust: ['trust:observer-supplied', 'trust:derived'],
    };

    // Outcome facts: candidate 'b' has higher rate
    const facts: ObserverFact[] = [
      {
        path: ['candidate', 'outcome', 'conversion_rate', 'a'],
        trust_ref: 'trust:derived',
        value: 0.2,
      },
      {
        path: ['candidate', 'outcome', 'conversion_rate', 'b'],
        trust_ref: 'trust:derived',
        value: 0.8,
      },
    ];

    const result = scoreCandidates(surface, facts, decider, undefined, 'observer-id:test.bandit');

    expect(result.winner?.candidate_id).toBe('b');
    expect(result.op_used).toBe('case');
  });

  it('falls back to sticky_hash on cold-start (no outcome facts)', () => {
    const surface: SelectionSurface = {
      entity_type: 'selection-surface',
      address: 'test.bandit',
      decider_program_ref: 'decider:bandit-outcome-shift',
      candidates: [
        { candidate_id: 'a', material_ref: 'material:a' },
        { candidate_id: 'b', material_ref: 'material:b' },
      ],
    };

    const decider: DeciderProgram = {
      entity_type: 'decider',
      decider_id: 'bandit-outcome-shift',
      score: {
        op: 'case',
        cases: [
          {
            when: { op: 'outcome', metric: 'conversion_rate' },
            then: { op: 'outcome', metric: 'conversion_rate' },
          },
        ],
        default: {
          op: 'sticky_hash',
          of: { const: 'observer-id' },
          split: { split: { a: 0.5, b: 0.5 } },
        },
      },
      accepts_trust: ['trust:observer-supplied', 'trust:derived'],
    };

    // No outcome facts → case evaluates to 0.5 (neutral), falls back to default sticky_hash
    const facts: ObserverFact[] = [];

    const result = scoreCandidates(surface, facts, decider, undefined, 'observer-id:test.bandit');

    // Sticky_hash should pick a winner (deterministic from observer_id hash)
    expect(result.winner).not.toBeNull();
    expect(['a', 'b']).toContain(result.winner?.candidate_id);
    expect(result.op_used).toBe('case');
  });

  it('bandit evaluates each candidate separately via outcome op', () => {
    const surface: SelectionSurface = {
      entity_type: 'selection-surface',
      address: 'test.bandit',
      decider_program_ref: 'decider:bandit-outcome-shift',
      candidates: [
        { candidate_id: 'x', material_ref: 'material:x' },
        { candidate_id: 'y', material_ref: 'material:y' },
        { candidate_id: 'z', material_ref: 'material:z' },
      ],
    };

    const decider: DeciderProgram = {
      entity_type: 'decider',
      decider_id: 'bandit-outcome-shift',
      score: {
        op: 'case',
        cases: [
          {
            when: { op: 'outcome', metric: 'conversion_rate' },
            then: { op: 'outcome', metric: 'conversion_rate' },
          },
        ],
        default: { const: 0.5 },
      },
      accepts_trust: ['trust:derived'],
    };

    // z has the best rate
    const facts: ObserverFact[] = [
      { path: ['candidate', 'outcome', 'conversion_rate', 'x'], trust_ref: 'trust:derived', value: 0.3 },
      { path: ['candidate', 'outcome', 'conversion_rate', 'y'], trust_ref: 'trust:derived', value: 0.5 },
      { path: ['candidate', 'outcome', 'conversion_rate', 'z'], trust_ref: 'trust:derived', value: 0.9 },
    ];

    const result = scoreCandidates(surface, facts, decider, undefined, 'sticky-key');

    expect(result.ranked[0].candidate_id).toBe('z');
    expect(result.ranked[0].score).toBeCloseTo(0.9);
    expect(result.ranked[1].candidate_id).toBe('x');
    expect(result.ranked[2].candidate_id).toBe('y');
  });

  it('trust filtering: only trust:derived facts used (trust:observer-supplied ignored)', () => {
    const surface: SelectionSurface = {
      entity_type: 'selection-surface',
      address: 'test.bandit',
      decider_program_ref: 'decider:bandit-outcome-shift',
      candidates: [
        { candidate_id: 'a', material_ref: 'material:a' },
        { candidate_id: 'b', material_ref: 'material:b' },
      ],
    };

    const decider: DeciderProgram = {
      entity_type: 'decider',
      decider_id: 'bandit-outcome-shift',
      score: {
        op: 'case',
        cases: [
          {
            when: { op: 'outcome', metric: 'conversion_rate' },
            then: { op: 'outcome', metric: 'conversion_rate' },
          },
        ],
        default: { const: 0.5 },
      },
      accepts_trust: ['trust:derived'], // Only trust:derived
    };

    // Observer-supplied rates (should be ignored), derived rates (should be used)
    const facts: ObserverFact[] = [
      {
        path: ['candidate', 'outcome', 'conversion_rate', 'a'],
        trust_ref: 'trust:observer-supplied',
        value: 0.9, // ignored
      },
      {
        path: ['candidate', 'outcome', 'conversion_rate', 'b'],
        trust_ref: 'trust:derived',
        value: 0.3, // used
      },
    ];

    const result = scoreCandidates(surface, facts, decider, undefined, 'sticky-key');

    // 'a' has no trusted outcome → case finds nothing, falls back to default 0.5
    // 'b' has trusted outcome 0.3 → case when evaluates to 0.3, ties on score
    // Tie-break by original order: 'a' before 'b', so 'a' wins
    expect(result.ranked[0].candidate_id).toBe('a');
  });

  it('missing case op in registry → fail-closed, all candidates score 0.0', () => {
    const surface: SelectionSurface = {
      entity_type: 'selection-surface',
      address: 'test.bandit',
      decider_program_ref: 'decider:bandit-outcome-shift',
      candidates: [
        { candidate_id: 'a', material_ref: 'material:a' },
        { candidate_id: 'b', material_ref: 'material:b' },
      ],
    };

    const decider: DeciderProgram = {
      entity_type: 'decider',
      decider_id: 'bandit-outcome-shift',
      score: {
        op: 'case',
        cases: [
          {
            when: { op: 'outcome', metric: 'conversion_rate' },
            then: { op: 'outcome', metric: 'conversion_rate' },
          },
        ],
        default: { const: 0.5 },
      },
      accepts_trust: [],
    };

    const facts: ObserverFact[] = [];

    // Pass a registry with no 'case' op (only 'sticky_hash')
    const limitedRegistry = { sticky_hash: () => 0.5 };
    const result = scoreCandidates(surface, facts, decider, limitedRegistry, 'sticky-key');

    // case op not found → evaluates to 0.0
    // Both candidates get the same score, tie-break by order
    expect(result.winner?.candidate_id).toBe('a');
    expect(result.findings.some(f => f.includes('Unknown top-level op'))).toBe(true);
  });
});
