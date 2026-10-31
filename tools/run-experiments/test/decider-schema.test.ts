// tools/run-experiments/test/decider-schema.test.ts
//
// Purpose: Unit + conformance tests for decider-schema.ts.
// Covers: valid programs, each invalid field, unknown op rejection,
// dot-encoded fact_path rejection, accepts_trust validation, multi-error
// reporting, nested op tree op-collection.

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  validateDecider,
  type DeciderProgram,
} from '../read-data/decider-schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimal(): DeciderProgram {
  return {
    entity_type: 'decider',
    decider_id: 'test-decider',
    score: { const: 1 },
    accepts_trust: ['trust:observer-supplied'],
  };
}

// ---------------------------------------------------------------------------
// Valid programs
// ---------------------------------------------------------------------------

describe('validateDecider — valid programs', () => {
  it('accepts a minimal const-score decider', () => {
    const result = validateDecider(minimal());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a fact_path score node', () => {
    const d: DeciderProgram = {
      ...minimal(),
      score: { fact_path: ['observer', 'signal', 'source'] },
    };
    expect(validateDecider(d).valid).toBe(true);
  });

  it('accepts a candidate_scores node', () => {
    const d: DeciderProgram = {
      ...minimal(),
      score: { candidate_scores: { a: 1.0, b: 0.0 } },
    };
    expect(validateDecider(d).valid).toBe(true);
  });

  it('accepts a split node', () => {
    const d: DeciderProgram = {
      ...minimal(),
      score: { split: { a: 0.5, b: 0.5 } },
    };
    expect(validateDecider(d).valid).toBe(true);
  });

  it('accepts an op node', () => {
    const d: DeciderProgram = {
      ...minimal(),
      score: { op: 'eq', left: { fact_path: ['x'] }, right: { const: 'y' } },
    };
    const known = new Set(['eq']);
    expect(validateDecider(d, known).valid).toBe(true);
  });

  it('accepts empty accepts_trust list (accepts all trust levels)', () => {
    const d: DeciderProgram = { ...minimal(), accepts_trust: [] };
    expect(validateDecider(d).valid).toBe(true);
  });

  it('accepts multiple trust descriptors', () => {
    const d: DeciderProgram = {
      ...minimal(),
      accepts_trust: ['trust:observer-supplied', 'trust:derived', 'trust:signed'],
    };
    expect(validateDecider(d).valid).toBe(true);
  });

  it('accepts optional label field', () => {
    const d: DeciderProgram = { ...minimal(), label: 'My Decider' };
    expect(validateDecider(d).valid).toBe(true);
  });

  it('accepts nested case op with known ops', () => {
    const d: DeciderProgram = {
      ...minimal(),
      score: {
        op: 'case',
        cases: [
          {
            when: { op: 'eq', left: { fact_path: ['src'] }, right: { const: 'yt' } },
            then: { candidate_scores: { a: 1.0 } },
          },
        ],
        default: { op: 'sticky_hash', of: { fact_path: ['id'] }, split: { split: { a: 1 } } },
      },
    };
    const known = new Set(['case', 'eq', 'sticky_hash']);
    expect(validateDecider(d, known).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid: entity_type
// ---------------------------------------------------------------------------

describe('validateDecider — entity_type', () => {
  it('rejects missing entity_type', () => {
    const d = { ...minimal(), entity_type: undefined } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('entity_type'))).toBe(true);
  });

  it('rejects wrong entity_type', () => {
    const d = { ...minimal(), entity_type: 'selection-surface' } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('entity_type'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid: decider_id
// ---------------------------------------------------------------------------

describe('validateDecider — decider_id', () => {
  it('rejects missing decider_id', () => {
    const d = { ...minimal(), decider_id: undefined } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('decider_id'))).toBe(true);
  });

  it('rejects empty string decider_id', () => {
    const d = { ...minimal(), decider_id: '  ' };
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid: score
// ---------------------------------------------------------------------------

describe('validateDecider — score', () => {
  it('rejects missing score', () => {
    const d = { ...minimal(), score: undefined } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('score'))).toBe(true);
  });

  it('rejects score as a string (not an object node)', () => {
    const d = { ...minimal(), score: 'utm==youtube' } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('score'))).toBe(true);
  });

  it('rejects score object with no discriminant field', () => {
    const d = { ...minimal(), score: { unknown_field: 'x' } } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('discriminant'))).toBe(true);
  });

  it('rejects dot-encoded fact_path (string instead of array)', () => {
    const d = { ...minimal(), score: { fact_path: 'observer.signal.source' } } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fact_path'))).toBe(true);
  });

  it('rejects fact_path with non-string elements', () => {
    const d = { ...minimal(), score: { fact_path: ['observer', 42, 'source'] } } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fact_path'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid: unknown op (with knownOps supplied)
// ---------------------------------------------------------------------------

describe('validateDecider — unknown op rejection', () => {
  it('rejects an op not in the known registry', () => {
    const d: DeciderProgram = {
      ...minimal(),
      score: { op: 'nonexistent-op-xyz' },
    };
    const knownOps = new Set(['eq', 'case', 'sticky_hash']);
    const result = validateDecider(d, knownOps);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('nonexistent-op-xyz'))).toBe(true);
  });

  it('skips op validation when knownOps is empty (schema-shape check only)', () => {
    const d: DeciderProgram = {
      ...minimal(),
      score: { op: 'any-op-name' },
    };
    // Empty knownOps → no op validation → valid (schema shape is fine)
    const result = validateDecider(d, new Set());
    expect(result.valid).toBe(true);
  });

  it('detects unknown op nested inside a case default', () => {
    const d: DeciderProgram = {
      ...minimal(),
      score: {
        op: 'case',
        cases: [],
        default: { op: 'unknown-nested-op' },
      },
    };
    const knownOps = new Set(['case']); // case is known, nested op is not
    const result = validateDecider(d, knownOps);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown-nested-op'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid: accepts_trust
// ---------------------------------------------------------------------------

describe('validateDecider — accepts_trust', () => {
  it('rejects non-array accepts_trust', () => {
    const d = { ...minimal(), accepts_trust: 'trust:observer-supplied' } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('accepts_trust'))).toBe(true);
  });

  it('rejects array with empty string element', () => {
    const d = { ...minimal(), accepts_trust: ['trust:ok', ''] };
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('accepts_trust[1]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-error reporting
// ---------------------------------------------------------------------------

describe('validateDecider — multi-error reporting', () => {
  it('reports all errors, not just the first', () => {
    const d = {
      entity_type: 'wrong-type',
      decider_id: '',
      score: undefined,
      accepts_trust: 'not-an-array',
    } as unknown;
    const result = validateDecider(d);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// Non-object inputs
// ---------------------------------------------------------------------------

describe('validateDecider — non-object inputs', () => {
  it('rejects null', () => {
    expect(validateDecider(null).valid).toBe(false);
  });
  it('rejects undefined', () => {
    expect(validateDecider(undefined).valid).toBe(false);
  });
  it('rejects array', () => {
    expect(validateDecider([]).valid).toBe(false);
  });
  it('rejects string', () => {
    expect(validateDecider('decider').valid).toBe(false);
  });
});
