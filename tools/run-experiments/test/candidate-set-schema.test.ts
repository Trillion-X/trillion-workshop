// tools/run-experiments/test/candidate-set-schema.test.ts
//
// Purpose: Unit + golden tests for candidate-set-schema.ts.
// Covers: N=0/1/≥2 valid surfaces, invalid fields, duplicate candidate_ids,
// tie_rule_ref validation, multi-error reporting.

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  validateCandidateSet,
  type SelectionSurface,
} from '../read-data/candidate-set-schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimal(override: Partial<SelectionSurface> = {}): SelectionSurface {
  return {
    entity_type: 'selection-surface',
    address: 'page:/test',
    decider_program_ref: 'decider:test',
    candidates: [],
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Valid surfaces
// ---------------------------------------------------------------------------

describe('validateCandidateSet — valid surfaces', () => {
  it('accepts N=0 (empty candidates — valid empty state)', () => {
    const result = validateCandidateSet(minimal({ candidates: [] }));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts N=1 (static degenerate — single candidate always wins)', () => {
    const result = validateCandidateSet(
      minimal({
        candidates: [{ candidate_id: 'only', material_ref: 'material:page-v1' }],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts N=2 (A/B surface)', () => {
    const result = validateCandidateSet(
      minimal({
        candidates: [
          { candidate_id: 'a', material_ref: 'material:headline-a' },
          { candidate_id: 'b', material_ref: 'material:headline-b' },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts N=5 (multivariate surface)', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      candidate_id: id,
      material_ref: `material:variant-${id}`,
    }));
    const result = validateCandidateSet(minimal({ candidates }));
    expect(result.valid).toBe(true);
  });

  it('accepts optional tie_rule_ref', () => {
    const result = validateCandidateSet(minimal({ tie_rule_ref: 'decider:order-first' }));
    expect(result.valid).toBe(true);
  });

  it('accepts optional epoch', () => {
    const result = validateCandidateSet(minimal({ epoch: '2026-06-26T00:00:00Z' }));
    expect(result.valid).toBe(true);
  });

  it('accepts optional label', () => {
    const result = validateCandidateSet(minimal({ label: 'Master class headline test' }));
    expect(result.valid).toBe(true);
  });

  it('accepts candidates with extra open fields', () => {
    const result = validateCandidateSet(
      minimal({
        candidates: [
          {
            candidate_id: 'a',
            material_ref: 'material:a',
            custom_weight: 0.7,
            description: 'Soccer mom copy',
          } as SelectionSurface['candidates'][number],
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid: entity_type
// ---------------------------------------------------------------------------

describe('validateCandidateSet — entity_type', () => {
  it('rejects wrong entity_type', () => {
    const r = validateCandidateSet({ ...minimal(), entity_type: 'decider' as 'selection-surface' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('entity_type'))).toBe(true);
  });

  it('rejects missing entity_type', () => {
    const r = validateCandidateSet({ ...minimal(), entity_type: undefined as unknown as 'selection-surface' });
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid: address
// ---------------------------------------------------------------------------

describe('validateCandidateSet — address', () => {
  it('rejects missing address', () => {
    const r = validateCandidateSet({ ...minimal(), address: undefined as unknown as string });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('address'))).toBe(true);
  });

  it('rejects empty string address', () => {
    const r = validateCandidateSet({ ...minimal(), address: '  ' });
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid: decider_program_ref
// ---------------------------------------------------------------------------

describe('validateCandidateSet — decider_program_ref', () => {
  it('rejects missing decider_program_ref', () => {
    const r = validateCandidateSet({ ...minimal(), decider_program_ref: undefined as unknown as string });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('decider_program_ref'))).toBe(true);
  });

  it('rejects empty string decider_program_ref', () => {
    const r = validateCandidateSet({ ...minimal(), decider_program_ref: '' });
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid: candidates
// ---------------------------------------------------------------------------

describe('validateCandidateSet — candidates', () => {
  it('rejects non-array candidates', () => {
    const r = validateCandidateSet({ ...minimal(), candidates: 'not-an-array' as unknown as [] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('candidates'))).toBe(true);
  });

  it('rejects candidate with missing candidate_id', () => {
    const r = validateCandidateSet(
      minimal({
        candidates: [{ candidate_id: undefined as unknown as string, material_ref: 'material:x' }],
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('candidate_id'))).toBe(true);
  });

  it('rejects candidate with empty candidate_id', () => {
    const r = validateCandidateSet(
      minimal({
        candidates: [{ candidate_id: '', material_ref: 'material:x' }],
      }),
    );
    expect(r.valid).toBe(false);
  });

  it('rejects candidate with missing material_ref', () => {
    const r = validateCandidateSet(
      minimal({
        candidates: [{ candidate_id: 'a', material_ref: undefined as unknown as string }],
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('material_ref'))).toBe(true);
  });

  it('rejects candidate with empty material_ref', () => {
    const r = validateCandidateSet(
      minimal({
        candidates: [{ candidate_id: 'a', material_ref: '' }],
      }),
    );
    expect(r.valid).toBe(false);
  });

  it('rejects duplicate candidate_ids', () => {
    const r = validateCandidateSet(
      minimal({
        candidates: [
          { candidate_id: 'a', material_ref: 'material:a' },
          { candidate_id: 'a', material_ref: 'material:a-variant' },
        ],
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('duplicated'))).toBe(true);
  });

  it('rejects non-object candidate (null)', () => {
    const r = validateCandidateSet(
      minimal({ candidates: [null as unknown as SelectionSurface['candidates'][number]] }),
    );
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid: tie_rule_ref (optional but must be non-empty if present)
// ---------------------------------------------------------------------------

describe('validateCandidateSet — tie_rule_ref', () => {
  it('rejects empty string tie_rule_ref', () => {
    const r = validateCandidateSet(minimal({ tie_rule_ref: '' }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('tie_rule_ref'))).toBe(true);
  });

  it('accepts undefined tie_rule_ref (absent = default candidate order)', () => {
    const r = validateCandidateSet(minimal({ tie_rule_ref: undefined }));
    expect(r.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Golden: N=1 degenerate is the static-page case
// ---------------------------------------------------------------------------

describe('validateCandidateSet — golden: N=1 degenerate (static page)', () => {
  it('a single-candidate surface with a sticky_hash{only:1.0} decider ref is valid', () => {
    // This is the DATA equivalent of "today's static 1:1 route→page behavior."
    // decider_program_ref points to a decider with sticky_hash{split:{only:1.0}}.
    const r = validateCandidateSet({
      entity_type: 'selection-surface',
      address: 'page:/master-class',
      decider_program_ref: 'decider:static-only',
      candidates: [
        { candidate_id: 'only', material_ref: 'material:master-class-page-v1' },
      ],
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-error reporting
// ---------------------------------------------------------------------------

describe('validateCandidateSet — multi-error reporting', () => {
  it('reports all errors, not just the first', () => {
    const r = validateCandidateSet({
      entity_type: 'wrong' as 'selection-surface',
      address: '',
      decider_program_ref: '',
      candidates: 'oops' as unknown as [],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// Non-object inputs
// ---------------------------------------------------------------------------

describe('validateCandidateSet — non-object inputs', () => {
  it('rejects null', () => expect(validateCandidateSet(null).valid).toBe(false));
  it('rejects undefined', () => expect(validateCandidateSet(undefined).valid).toBe(false));
  it('rejects array', () => expect(validateCandidateSet([]).valid).toBe(false));
  it('rejects string', () => expect(validateCandidateSet('surface').valid).toBe(false));
});
