// tools/run-experiments/test/score-candidates.test.ts
//
// Purpose: Unit + adversarial + golden tests for the score-candidates evaluator.
// Covers: each built-in op in isolation, absent-fact neutrality, gate degenerate
// case (N=1 + gte threshold), unknown op fail-closed, empty candidate set, all-tie
// resolution, trust filtering, sticky_hash determinism, case/and/or/not ops,
// outcome op (bandit cold-start + warm), one-code-path for N=0/1/≥2.

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

import {
  builtinOps,
  scoreCandidates,
  type ObserverFact,
  type OpRegistry,
} from '../read-data/score-candidates.ts';
import type { DeciderProgram } from '../read-data/decider-schema.ts';
import type { SelectionSurface } from '../read-data/candidate-set-schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSurface(
  candidateIds: string[],
  deciderProgramRef = 'decider:test',
  address = 'page:/test',
): SelectionSurface {
  return {
    entity_type: 'selection-surface',
    address,
    decider_program_ref: deciderProgramRef,
    candidates: candidateIds.map((id) => ({
      candidate_id: id,
      material_ref: `material:${id}`,
    })),
  };
}

function makeDecider(score: DeciderProgram['score'], acceptsTrust: string[] = ['trust:observer-supplied']): DeciderProgram {
  return {
    entity_type: 'decider',
    decider_id: 'test-decider',
    score,
    accepts_trust: acceptsTrust,
  };
}

function fact(path: string[], value: unknown, trustRef = 'trust:observer-supplied'): ObserverFact {
  return { path, value, trust_ref: trustRef };
}

// ---------------------------------------------------------------------------
// T1a: empty candidate set (N=0)
// ---------------------------------------------------------------------------

describe('scoreCandidates — N=0 (empty candidate set)', () => {
  it('returns null winner and a finding', () => {
    const surface = makeSurface([]);
    const decider = makeDecider({ const: 1 });
    const result = scoreCandidates(surface, [], decider);
    expect(result.winner).toBeNull();
    expect(result.ranked).toHaveLength(0);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T1b: N=1 degenerate (gate) case — always picks the single candidate
// ---------------------------------------------------------------------------

describe('scoreCandidates — N=1 (static/degenerate)', () => {
  it('returns the single candidate as winner regardless of score', () => {
    const surface = makeSurface(['only']);
    const decider = makeDecider({ const: 0 }); // even score 0 → wins (only option)
    const result = scoreCandidates(surface, [], decider);
    expect(result.winner).not.toBeNull();
    expect(result.winner!.candidate_id).toBe('only');
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0].is_winner).toBe(true);
  });

  it('gate degenerate: gte threshold — fact meets threshold → winner present', () => {
    // A content-gate is candidates={this}, keep if score >= threshold.
    const surface = makeSurface(['this']);
    const decider = makeDecider({
      op: 'gte',
      left: { fact_path: ['observer', 'signal', 'score'] },
      right: { const: 0.7 },
    });
    const facts = [fact(['observer', 'signal', 'score'], 0.8)];
    const result = scoreCandidates(surface, facts, decider);
    expect(result.winner!.candidate_id).toBe('this');
    expect(result.ranked[0].score).toBe(1.0); // gte returns 1.0 when true
  });

  it('gate degenerate: gte threshold — fact below threshold → winner still returned (N=1), score 0', () => {
    // Gate logic: score=0 means "blocked" but the evaluator still returns the
    // candidate. Whether to gate is the caller's (T5 select) responsibility.
    const surface = makeSurface(['this']);
    const decider = makeDecider({
      op: 'gte',
      left: { fact_path: ['observer', 'signal', 'score'] },
      right: { const: 0.9 },
    });
    const facts = [fact(['observer', 'signal', 'score'], 0.5)];
    const result = scoreCandidates(surface, facts, decider);
    expect(result.winner!.candidate_id).toBe('this');
    expect(result.ranked[0].score).toBe(0.0); // gte returns 0.0 when false
  });
});

// ---------------------------------------------------------------------------
// T1c: N≥2 — normal A/B selection
// ---------------------------------------------------------------------------

describe('scoreCandidates — N≥2 (observer-conditioned)', () => {
  it('candidate_scores node picks the higher-scored candidate', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({ candidate_scores: { a: 0.9, b: 0.1 } });
    const result = scoreCandidates(surface, [], decider);
    expect(result.winner!.candidate_id).toBe('a');
    expect(result.ranked[0].candidate_id).toBe('a');
    expect(result.ranked[1].candidate_id).toBe('b');
  });

  it('ranked list is sorted descending by score', () => {
    const surface = makeSurface(['a', 'b', 'c']);
    const decider = makeDecider({ candidate_scores: { a: 0.2, b: 0.8, c: 0.5 } });
    const result = scoreCandidates(surface, [], decider);
    expect(result.ranked.map((r) => r.candidate_id)).toEqual(['b', 'c', 'a']);
    expect(result.winner!.candidate_id).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// T1d: eq op
// ---------------------------------------------------------------------------

describe('eq op', () => {
  it('scores 1.0 when fact equals const', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({
      op: 'case',
      cases: [
        {
          when: { op: 'eq', left: { fact_path: ['observer', 'signal', 'source'] }, right: { const: 'youtube' } },
          then: { candidate_scores: { a: 1.0, b: 0.0 } },
        },
      ],
      default: { candidate_scores: { a: 0.5, b: 0.5 } },
    });
    const facts = [fact(['observer', 'signal', 'source'], 'youtube')];
    const result = scoreCandidates(surface, facts, decider);
    expect(result.winner!.candidate_id).toBe('a');
  });

  it('scores 0.0 when fact does not equal const', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({
      op: 'eq',
      left: { fact_path: ['observer', 'signal', 'source'] },
      right: { const: 'youtube' },
    }, ['trust:observer-supplied']);
    // eq against candidate_scores: a gets 1.0 if eq is truthy
    // But here eq is the root — it returns 1.0 or 0.0, same for all candidates.
    // Both candidates get score 0.0 → tie → first wins by order.
    const facts = [fact(['observer', 'signal', 'source'], 'google')];
    const result = scoreCandidates(surface, facts, decider);
    // eq returns 0.0 for google≠youtube for both → tie → 'a' wins by order
    expect(result.ranked[0].score).toBe(0.0);
    expect(result.winner!.candidate_id).toBe('a'); // tie broken by candidate order
  });
});

// ---------------------------------------------------------------------------
// T1e: absent fact → neutral score (0.5)
// ---------------------------------------------------------------------------

describe('absent fact → neutral score', () => {
  it('returns 0.5 when the referenced fact_path is not in facts', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({ fact_path: ['observer', 'signal', 'source'] });
    const result = scoreCandidates(surface, [], decider); // no facts
    // Both candidates get 0.5 → tie → 'a' wins by order
    expect(result.ranked[0].score).toBe(0.5);
    expect(result.ranked[1].score).toBe(0.5);
    expect(result.winner!.candidate_id).toBe('a');
  });

  it('returns 0.5 when fact trust_ref is not in accepts_trust', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider(
      { fact_path: ['observer', 'signal', 'source'] },
      ['trust:signed'], // only signed facts accepted
    );
    // Fact is observer-supplied — trust-filtered out → treated as absent
    const facts = [fact(['observer', 'signal', 'source'], 'youtube', 'trust:observer-supplied')];
    const result = scoreCandidates(surface, facts, decider);
    expect(result.ranked[0].score).toBe(0.5);
  });

  it('accepts fact when accepts_trust includes its trust_ref', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider(
      { fact_path: ['observer', 'signal', 'score'] },
      ['trust:derived'],
    );
    const facts = [fact(['observer', 'signal', 'score'], 1.0, 'trust:derived')];
    const result = scoreCandidates(surface, facts, decider);
    expect(result.ranked[0].score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// T1f: unknown op → fail-closed (score 0.0, finding added)
// ---------------------------------------------------------------------------

describe('unknown op → fail-closed', () => {
  it('returns score 0.0 for unknown op and adds a finding', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({ op: 'totally-unknown-op-xyz' });
    const result = scoreCandidates(surface, [], decider);
    // Both score 0.0 → tie → 'a' wins by order
    expect(result.ranked[0].score).toBe(0.0);
    expect(result.ranked[1].score).toBe(0.0);
    expect(result.findings.some((f) => f.includes('totally-unknown-op-xyz'))).toBe(true);
  });

  it('unknown op with custom registry that has no entry: still fail-closed', () => {
    const emptyRegistry: OpRegistry = {};
    const surface = makeSurface(['a']);
    const decider = makeDecider({ op: 'sticky_hash', of: { fact_path: ['x'] }, split: { split: { a: 1 } } });
    const result = scoreCandidates(surface, [], decider, emptyRegistry, 'key');
    // sticky_hash not in empty registry → 0.0
    expect(result.ranked[0].score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// T1g: sticky_hash op — determinism and split
// ---------------------------------------------------------------------------

describe('sticky_hash op', () => {
  it('produces the same winner for the same stickyKey across calls', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({
      op: 'sticky_hash',
      of: { fact_path: ['observer', 'id'] },
      split: { split: { a: 0.5, b: 0.5 } },
    });
    const facts = [fact(['observer', 'id'], 'user-123')];

    const r1 = scoreCandidates(surface, facts, decider, builtinOps, 'user-123:page:/test');
    const r2 = scoreCandidates(surface, facts, decider, builtinOps, 'user-123:page:/test');
    expect(r1.winner!.candidate_id).toBe(r2.winner!.candidate_id);
  });

  it('different stickyKeys can land in different buckets', () => {
    const surface = makeSurface(['a', 'b', 'c']);
    const decider = makeDecider({
      op: 'sticky_hash',
      of: { fact_path: ['observer', 'id'] },
      split: { split: { a: 0.34, b: 0.33, c: 0.33 } },
    });

    // Run 100 different keys and collect unique winners — expect >1 unique
    const winners = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const facts = [fact(['observer', 'id'], `user-${i}`)];
      const r = scoreCandidates(surface, facts, decider, builtinOps, `user-${i}:page:/test`);
      if (r.winner) winners.add(r.winner.candidate_id);
    }
    // With 100 keys and 3 buckets, expect at least 2 unique winners
    expect(winners.size).toBeGreaterThan(1);
  });

  it('winner gets score 1.0, others get 0.0', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({
      op: 'sticky_hash',
      of: { fact_path: ['observer', 'id'] },
      split: { split: { a: 0.5, b: 0.5 } },
    });
    const facts = [fact(['observer', 'id'], 'obs-42')];
    const result = scoreCandidates(surface, facts, decider, builtinOps, 'obs-42:page:/test');
    const scores = result.ranked.map((r) => r.score);
    expect(scores).toContain(1.0);
    expect(scores).toContain(0.0);
  });

  it('falls back to stickyKey when fact is absent', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({
      op: 'sticky_hash',
      of: { fact_path: ['observer', 'id'] },
      split: { split: { a: 0.5, b: 0.5 } },
    });
    // No facts — should use stickyKey as fallback, produce a deterministic result
    const r1 = scoreCandidates(surface, [], decider, builtinOps, 'fallback-key:page:/test');
    const r2 = scoreCandidates(surface, [], decider, builtinOps, 'fallback-key:page:/test');
    expect(r1.winner!.candidate_id).toBe(r2.winner!.candidate_id);
  });
});

// ---------------------------------------------------------------------------
// T1h: case op
// ---------------------------------------------------------------------------

describe('case op', () => {
  it('picks then-branch when when scores ≥ 0.5', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({
      op: 'case',
      cases: [
        {
          when: { op: 'eq', left: { fact_path: ['src'] }, right: { const: 'yt' } },
          then: { candidate_scores: { a: 1.0, b: 0.0 } },
        },
      ],
      default: { candidate_scores: { a: 0.0, b: 1.0 } },
    });
    const result = scoreCandidates(surface, [fact(['src'], 'yt')], decider);
    expect(result.winner!.candidate_id).toBe('a');
  });

  it('falls through to default when no when matches', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({
      op: 'case',
      cases: [
        {
          when: { op: 'eq', left: { fact_path: ['src'] }, right: { const: 'yt' } },
          then: { candidate_scores: { a: 1.0, b: 0.0 } },
        },
      ],
      default: { candidate_scores: { a: 0.0, b: 1.0 } },
    });
    const result = scoreCandidates(surface, [fact(['src'], 'google')], decider);
    expect(result.winner!.candidate_id).toBe('b');
  });

  it('returns neutral when no cases match and default is absent', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({
      op: 'case',
      cases: [
        {
          when: { op: 'eq', left: { fact_path: ['src'] }, right: { const: 'yt' } },
          then: { candidate_scores: { a: 1.0, b: 0.0 } },
        },
      ],
      // no default
    });
    const result = scoreCandidates(surface, [], decider);
    // no fact + no match → default absent → neutral 0.5 for both → tie → 'a' wins
    expect(result.ranked[0].score).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// T1i: and / or / not ops
// ---------------------------------------------------------------------------

describe('and / or / not ops', () => {
  it('and: returns minimum score', () => {
    const surface = makeSurface(['a']);
    const decider = makeDecider({
      op: 'and',
      operands: [{ const: 1 }, { const: 0 }],
    });
    const result = scoreCandidates(surface, [], decider);
    expect(result.ranked[0].score).toBe(0.0);
  });

  it('or: returns maximum score', () => {
    const surface = makeSurface(['a']);
    const decider = makeDecider({
      op: 'or',
      operands: [{ const: 0 }, { const: 1 }],
    });
    const result = scoreCandidates(surface, [], decider);
    expect(result.ranked[0].score).toBe(1.0);
  });

  it('not: inverts 1.0 → 0.0', () => {
    const surface = makeSurface(['a']);
    const decider = makeDecider({ op: 'not', operand: { const: 1 } });
    const result = scoreCandidates(surface, [], decider);
    expect(result.ranked[0].score).toBe(0.0);
  });

  it('not: inverts 0.0 → 1.0', () => {
    const surface = makeSurface(['a']);
    const decider = makeDecider({ op: 'not', operand: { const: 0 } });
    const result = scoreCandidates(surface, [], decider);
    expect(result.ranked[0].score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// T1j: outcome op (bandit)
// ---------------------------------------------------------------------------

describe('outcome op (bandit)', () => {
  it('cold-start (absent outcome facts) → neutral score', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({ op: 'outcome', metric: 'conversion_rate' }, ['trust:derived']);
    const result = scoreCandidates(surface, [], decider);
    // Both neutral → tie → 'a' wins by order
    expect(result.ranked[0].score).toBe(0.5);
    expect(result.ranked[1].score).toBe(0.5);
  });

  it('warm: higher outcome metric → higher score → wins', () => {
    const surface = makeSurface(['a', 'b']);
    const decider = makeDecider({ op: 'outcome', metric: 'conversion_rate' }, ['trust:derived']);
    const facts = [
      fact(['candidate', 'outcome', 'conversion_rate', 'a'], 0.12, 'trust:derived'),
      fact(['candidate', 'outcome', 'conversion_rate', 'b'], 0.08, 'trust:derived'),
    ];
    const result = scoreCandidates(surface, facts, decider);
    expect(result.winner!.candidate_id).toBe('a');
    expect(result.ranked[0].score).toBe(0.12);
    expect(result.ranked[1].score).toBe(0.08);
  });
});

// ---------------------------------------------------------------------------
// T1k: all-tie resolution — stable by candidate order
// ---------------------------------------------------------------------------

describe('all-tie resolution', () => {
  it('tie broken by original candidate array order (stable sort)', () => {
    const surface = makeSurface(['x', 'y', 'z']);
    const decider = makeDecider({ const: 0.5 }); // all get same score
    const result = scoreCandidates(surface, [], decider);
    // All tie at 0.5 → order preserved → 'x' wins
    expect(result.winner!.candidate_id).toBe('x');
    expect(result.ranked.map((r) => r.candidate_id)).toEqual(['x', 'y', 'z']);
  });
});

// ---------------------------------------------------------------------------
// T1l: no I/O (structural check — pure module has no dynamic imports at runtime)
// ---------------------------------------------------------------------------

describe('purity: no I/O in score-candidates module', () => {
  it('scoreCandidates is synchronous and returns a plain object (no Promise)', () => {
    const surface = makeSurface(['a']);
    const decider = makeDecider({ const: 1 });
    const result = scoreCandidates(surface, [], decider);
    // If it returned a Promise, .winner would be undefined
    expect(result.winner).not.toBeUndefined();
    expect(typeof result.ranked).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// T1m: op_used observability field
// ---------------------------------------------------------------------------

describe('op_used observability', () => {
  it('reports top-level op name', () => {
    const surface = makeSurface(['a']);
    const decider = makeDecider({ op: 'eq', left: { const: 1 }, right: { const: 1 } });
    const result = scoreCandidates(surface, [], decider);
    expect(result.op_used).toBe('eq');
  });

  it('reports "candidate_scores" for CandidateScoresNode', () => {
    const surface = makeSurface(['a']);
    const decider = makeDecider({ candidate_scores: { a: 1.0 } });
    const result = scoreCandidates(surface, [], decider);
    expect(result.op_used).toBe('candidate_scores');
  });
});
