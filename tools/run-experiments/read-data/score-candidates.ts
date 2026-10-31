// tools/run-experiments/read-data/score-candidates.ts
//
// Purpose: Pure leaf evaluator — given a candidate set, observer facts, and a
// decider program (score expression), returns a ranked list with a winner and
// per-candidate findings.
//
// A content-gate is the DEGENERATE configuration of this evaluator:
//   candidates = [{candidate_id:"this", material_ref:"<the item>"}]
//   decider score = { op:"gte", left:{fact_path:[...]}, right:{const:threshold} }
//   result.winner present ↔ the gate passes.
// Gate and selector are two DATA configurations of one evaluator — no fork.
//
// Non-negotiable invariants (plan §13 adversarial closure + §9 One-or-List law):
//   1. Op dispatch is REGISTRY-only. Never switch(op) / if(op==='…'). New op =
//      register one entry in OpRegistry, zero evaluator edits (L090).
//   2. Absent fact → neutral score (0.5). Unknown op → fail-closed: score 0.0,
//      forward to tie_rule resolution.
//   3. Candidate cardinality 0..∞ — N=0/1/≥2 follow ONE code path, no branch.
//   4. Trust filtering: facts whose trust_ref is absent from decider.accepts_trust
//      are treated as absent (neutral). Trust is an open DATA property.
//   5. All scoring is per-candidate, deterministic, pure: no I/O, no side effects.
//   6. `sticky_hash` op: stable bucket assignment derived from a hash of the
//      observer_id + address, split by DATA weights. Deterministic, not random.
//
// Shared primitive with content-gate: content-gate can import OpRegistry,
// ScoreContext, and evalExpr from this module to build its own registry pack.
//
// Dependencies: pure — zero I/O imports.

import type {
  CandidateScoresNode,
  ConstNode,
  DeciderProgram,
  FactPathNode,
  OpNode,
  ScoreExpr,
  SplitNode,
} from './decider-schema.ts';
import type { Candidate, SelectionSurface } from './candidate-set-schema.ts';

// ---------------------------------------------------------------------------
// Observer facts (input)
// ---------------------------------------------------------------------------

/**
 * One observer fact as presented to the evaluator. `path` is the structured
 * array address (mirrors FactPathNode.fact_path). `trust_ref` is an open
 * `trust:*` descriptor ref string — the evaluator compares it to
 * DeciderProgram.accepts_trust to decide whether to use the fact.
 * `value` is the raw fact value (any JSON-compatible type).
 */
export interface ObserverFact {
  path: string[];
  trust_ref: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Op registry (the ONLY dispatch table)
// ---------------------------------------------------------------------------

/**
 * Evaluation context passed to every op handler.
 * Gives each handler read-only access to candidates, facts, and the
 * decider program so composite ops (case, and, or) can recurse.
 */
export interface ScoreContext {
  /** All candidates in this evaluation run. */
  candidates: Candidate[];
  /** The candidate currently being scored. */
  candidate: Candidate;
  /** All observer facts presented to this evaluation run. */
  facts: ObserverFact[];
  /** The decider program being executed (for trust filtering). */
  decider: DeciderProgram;
  /** Stable identity string for sticky_hash (e.g. observer_id + ":" + address). */
  stickyKey: string;
  /** Evaluate a sub-expression (allows composite ops to recurse). */
  evalExpr: (expr: ScoreExpr, ctx: ScoreContext) => number;
}

/**
 * An op handler: takes the OpNode and the evaluation context; returns a
 * score in [0.0, 1.0] for the current candidate.
 *
 * Conventions:
 *   - 0.0 = strong signal against this candidate.
 *   - 0.5 = neutral (absent fact, no signal).
 *   - 1.0 = strong signal for this candidate.
 *   - Values outside [0,1] are clamped by the caller.
 */
export type OpHandler = (node: OpNode, ctx: ScoreContext) => number;

/**
 * Registry map from op string to its handler.
 * The ONLY dispatch table. Extend by spreading:
 *   { ...builtinOps, 'my-custom-op': myHandler }
 */
export type OpRegistry = Record<string, OpHandler>;

// ---------------------------------------------------------------------------
// Fact lookup helpers
// ---------------------------------------------------------------------------

const NEUTRAL_SCORE = 0.5;

/** Retrieve a fact value by exact path match, respecting trust filtering. */
function lookupFact(
  path: string[],
  facts: ObserverFact[],
  acceptsTrust: string[],
): { found: true; value: unknown } | { found: false } {
  const pathStr = path.join('\x00'); // null-byte join — paths never contain null
  for (const fact of facts) {
    if (fact.path.join('\x00') !== pathStr) continue;
    // Trust gate: if accepts_trust is empty, accept all; otherwise must match.
    if (acceptsTrust.length > 0 && !acceptsTrust.includes(fact.trust_ref)) continue;
    return { found: true, value: fact.value };
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// evalExpr — the core recursive interpreter
// ---------------------------------------------------------------------------

/**
 * Evaluate a ScoreExpr for the current candidate in ctx.
 * Returns a raw score (any number — caller clamps to [0,1]).
 * "Raw" because composite ops like `case` pass through sub-expr results
 * unchanged; clamping happens once at the top level in scoreCandidates.
 */
export function evalExpr(expr: ScoreExpr, ctx: ScoreContext): number {
  // OpNode — MUST be checked first. An OpNode may contain any key alongside
  // `op` (e.g. sticky_hash carries `split`, case carries `cases`). If we
  // checked leaf discriminants first, a node like
  //   { op:"sticky_hash", split:{...} }
  // would incorrectly match the SplitNode branch before reaching OpNode.
  if ('op' in expr) {
    const node = expr as OpNode;
    const handler = (ctx as unknown as { _registry: OpRegistry })._registry[node.op];
    if (handler === undefined) {
      // Unknown op — fail-closed (score 0.0, not a throw)
      return 0.0;
    }
    return handler(node, ctx);
  }

  // FactPathNode
  if ('fact_path' in expr) {
    const node = expr as FactPathNode;
    const result = lookupFact(node.fact_path, ctx.facts, ctx.decider.accepts_trust);
    if (!result.found) return NEUTRAL_SCORE;
    // A fact value used as a score: coerce to number in [0,1].
    const v = result.value;
    if (typeof v === 'boolean') return v ? 1.0 : 0.0;
    if (typeof v === 'number') return Math.max(0, Math.min(1, v));
    // Non-numeric fact value used directly as a score → neutral (caller
    // should use eq/case to compare it, not use it as a raw score).
    return NEUTRAL_SCORE;
  }

  // ConstNode
  if ('const' in expr) {
    const node = expr as ConstNode;
    const v = node.const;
    if (typeof v === 'boolean') return v ? 1.0 : 0.0;
    if (typeof v === 'number') return Math.max(0, Math.min(1, v));
    if (v === null) return NEUTRAL_SCORE;
    return NEUTRAL_SCORE;
  }

  // CandidateScoresNode — direct per-candidate score lookup
  if ('candidate_scores' in expr) {
    const node = expr as CandidateScoresNode;
    const score = node.candidate_scores[ctx.candidate.candidate_id];
    // Absent candidate → neutral
    return score !== undefined ? score : NEUTRAL_SCORE;
  }

  // SplitNode — should only appear inside a sticky_hash op; evaluated directly
  // here only if encountered as a standalone root (treated as neutral).
  if ('split' in expr) {
    return NEUTRAL_SCORE;
  }

  // Unrecognised node shape → neutral
  return NEUTRAL_SCORE;
}

// ---------------------------------------------------------------------------
// Built-in op handlers
// ---------------------------------------------------------------------------

/**
 * Stable numeric hash of a string (FNV-1a 32-bit — deterministic, no crypto).
 * Returns an unsigned 32-bit integer in [0, 2^32).
 *
 * FNV-1a is chosen over djb2 because djb2 produces near-identical outputs for
 * short strings that differ only in a trailing digit (e.g. "user-0".."user-99"
 * all cluster around the same value under djb2, making split bucketing
 * degenerate). FNV-1a mixes per-byte with XOR-then-multiply, giving good
 * avalanche for the short observer-id strings typical in this package.
 */
function stableHash(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime (32-bit multiply, no overflow)
    h = h >>> 0; // keep as unsigned 32-bit
  }
  return h;
}

/** A stable group number for an observer. Eligibility is decided separately; this only assigns a group. */
export function observerBucket(observerKey: string, count: number): number {
  if (typeof observerKey !== 'string' || !observerKey || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('A stable observer key and a positive whole group count are required.');
  }
  return Math.floor((stableHash(observerKey) / 0x100000000) * count);
}

/**
 * sticky_hash op: assigns the current candidate a score based on a stable
 * bucket assignment derived from `of` (a fact_path or const that yields a
 * string key, typically the observer-id). The `split` field maps
 * candidate_id → weight. The observer lands in one bucket deterministically;
 * that bucket's candidate gets 1.0, all others get 0.0.
 *
 * Node shape: { op:"sticky_hash", of: ScoreExpr, split: SplitNode }
 */
const stickyHashHandler: OpHandler = (node, ctx) => {
  const ofExpr = node['of'] as ScoreExpr | undefined;
  const splitNode = node['split'] as SplitNode | undefined;

  if (ofExpr == null || splitNode == null) return NEUTRAL_SCORE;

  // Resolve the key: we need the raw string value of the fact, not the
  // normalised 0-1 score. Look it up directly.
  let keyStr: string = ctx.stickyKey; // fallback to the provided stable key
  if ('fact_path' in ofExpr) {
    const result = lookupFact(
      (ofExpr as FactPathNode).fact_path,
      ctx.facts,
      ctx.decider.accepts_trust,
    );
    if (result.found && typeof result.value === 'string') keyStr = result.value;
  } else if ('const' in ofExpr) {
    const v = (ofExpr as ConstNode).const;
    if (typeof v === 'string') keyStr = v;
  }

  // Fail-closed (L083): a malformed/absent split (e.g. a hand-authored decider
  // that omits the inner `split` map) must NOT crash the evaluator — it scores
  // neutral, same as an absent fact or unknown op. No -1000IQ author can break it.
  const split = splitNode?.split;
  if (!split || typeof split !== 'object') return NEUTRAL_SCORE;
  const candidateIds = Object.keys(split);
  if (candidateIds.length === 0) return NEUTRAL_SCORE;

  // Normalise weights to cumulative buckets.
  const totalWeight = candidateIds.reduce((sum, id) => sum + (split[id] ?? 0), 0);
  if (totalWeight === 0) return NEUTRAL_SCORE;

  const hash = stableHash(keyStr);
  const bucket = hash / 0x100000000; // 0..0.9999… (full 32-bit range, no modulo bias)

  let cumulative = 0;
  let winner: string | null = null;
  for (const id of candidateIds) {
    cumulative += (split[id] ?? 0) / totalWeight;
    if (bucket < cumulative) {
      winner = id;
      break;
    }
  }
  // Edge: floating-point overshoot — assign last candidate
  if (winner === null) winner = candidateIds[candidateIds.length - 1];

  return winner === ctx.candidate.candidate_id ? 1.0 : 0.0;
};

/**
 * eq op: { op:"eq", left:ScoreExpr, right:ScoreExpr }
 * Returns 1.0 if left and right evaluate to the same primitive value,
 * 0.0 otherwise. "Same value" = strict equality on the resolved raw values.
 * For fact_path nodes, we compare the raw fact value (not the 0-1 score).
 */
function resolveRaw(expr: ScoreExpr, ctx: ScoreContext): unknown {
  if ('fact_path' in expr) {
    const result = lookupFact(
      (expr as FactPathNode).fact_path,
      ctx.facts,
      ctx.decider.accepts_trust,
    );
    return result.found ? result.value : undefined;
  }
  if ('const' in expr) return (expr as ConstNode).const;
  // For other nodes, evaluate as a number score and use that as the value.
  return ctx.evalExpr(expr, ctx);
}

const eqHandler: OpHandler = (node, ctx) => {
  const left = resolveRaw(node['left'] as ScoreExpr, ctx);
  const right = resolveRaw(node['right'] as ScoreExpr, ctx);
  return left === right ? 1.0 : 0.0;
};

/**
 * lt op: { op:"lt", left:ScoreExpr, right:ScoreExpr }
 * Returns 1.0 if left < right (numeric comparison), 0.0 otherwise.
 */
const ltHandler: OpHandler = (node, ctx) => {
  const left = resolveRaw(node['left'] as ScoreExpr, ctx);
  const right = resolveRaw(node['right'] as ScoreExpr, ctx);
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? 1.0 : 0.0;
  }
  return NEUTRAL_SCORE;
};

/**
 * gt op: { op:"gt", left:ScoreExpr, right:ScoreExpr }
 */
const gtHandler: OpHandler = (node, ctx) => {
  const left = resolveRaw(node['left'] as ScoreExpr, ctx);
  const right = resolveRaw(node['right'] as ScoreExpr, ctx);
  if (typeof left === 'number' && typeof right === 'number') {
    return left > right ? 1.0 : 0.0;
  }
  return NEUTRAL_SCORE;
};

/**
 * gte op: { op:"gte", left:ScoreExpr, right:ScoreExpr }
 * Primarily used for the gate degenerate case: score >= threshold.
 */
const gteHandler: OpHandler = (node, ctx) => {
  const left = resolveRaw(node['left'] as ScoreExpr, ctx);
  const right = resolveRaw(node['right'] as ScoreExpr, ctx);
  if (typeof left === 'number' && typeof right === 'number') {
    return left >= right ? 1.0 : 0.0;
  }
  return NEUTRAL_SCORE;
};

/**
 * not op: { op:"not", operand:ScoreExpr }
 * Inverts: 1.0 → 0.0, 0.0 → 1.0, 0.5 → 0.5 (neutral stays neutral).
 */
const notHandler: OpHandler = (node, ctx) => {
  const score = ctx.evalExpr(node['operand'] as ScoreExpr, ctx);
  return 1.0 - score;
};

/**
 * and op: { op:"and", operands:ScoreExpr[] }
 * Returns the minimum score across all operands (weakest-link conjunction).
 * Empty operands → 1.0 (vacuously true).
 */
const andHandler: OpHandler = (node, ctx) => {
  const operands = (node['operands'] as ScoreExpr[]) ?? [];
  if (operands.length === 0) return 1.0;
  return operands.reduce((min, expr) => Math.min(min, ctx.evalExpr(expr, ctx)), 1.0);
};

/**
 * or op: { op:"or", operands:ScoreExpr[] }
 * Returns the maximum score across all operands (strongest-signal disjunction).
 * Empty operands → 0.0 (vacuously false).
 */
const orHandler: OpHandler = (node, ctx) => {
  const operands = (node['operands'] as ScoreExpr[]) ?? [];
  if (operands.length === 0) return 0.0;
  return operands.reduce((max, expr) => Math.max(max, ctx.evalExpr(expr, ctx)), 0.0);
};

/**
 * case op: { op:"case", cases:[{when:ScoreExpr, then:ScoreExpr}], default:ScoreExpr }
 * Evaluates each `when` in order; on the first that scores ≥ 0.5 (truthy),
 * returns the corresponding `then` score. Falls through to `default` if none match.
 * Absent `default` returns neutral.
 */
const caseHandler: OpHandler = (node, ctx) => {
  const cases = (node['cases'] as Array<{ when: ScoreExpr; then: ScoreExpr }>) ?? [];
  for (const clause of cases) {
    const condScore = ctx.evalExpr(clause.when, ctx);
    if (condScore >= 0.5) {
      return ctx.evalExpr(clause.then, ctx);
    }
  }
  const defaultExpr = node['default'] as ScoreExpr | undefined;
  return defaultExpr != null ? ctx.evalExpr(defaultExpr, ctx) : NEUTRAL_SCORE;
};

/**
 * outcome op: { op:"outcome", metric:string, candidate_id_path?:ScoreExpr }
 * Reads the recorded outcome metric (e.g. "conversion_rate") for the current
 * candidate from the observer facts at path ["candidate","outcome",metric,candidate_id].
 * Returns the raw numeric value normalised to [0,1] (assumed to be in that range
 * already for rates; absolute counts should use a normalising wrapper).
 * Absent metric → neutral (cold-start bandit case).
 */
const outcomeHandler: OpHandler = (node, ctx) => {
  const metric = node['metric'] as string | undefined;
  if (metric == null) return NEUTRAL_SCORE;
  const candidateId = ctx.candidate.candidate_id;
  const factPath = ['candidate', 'outcome', metric, candidateId];
  const result = lookupFact(factPath, ctx.facts, ctx.decider.accepts_trust);
  if (!result.found) return NEUTRAL_SCORE;
  const v = result.value;
  if (typeof v === 'number') return Math.max(0, Math.min(1, v));
  return NEUTRAL_SCORE;
};

/**
 * The built-in op registry. Pass this (or a superset) to scoreCandidates.
 * Extend by spreading: { ...builtinOps, 'my-op': myHandler }
 */
export const builtinOps: OpRegistry = {
  sticky_hash: stickyHashHandler,
  eq: eqHandler,
  lt: ltHandler,
  gt: gtHandler,
  gte: gteHandler,
  not: notHandler,
  and: andHandler,
  or: orHandler,
  case: caseHandler,
  outcome: outcomeHandler,
};

// ---------------------------------------------------------------------------
// scoreCandidates — the top-level pure evaluator
// ---------------------------------------------------------------------------

/**
 * Per-candidate scoring result.
 */
export interface CandidateResult {
  candidate_id: string;
  /** Clamped score in [0, 1]. Higher = stronger selection signal. */
  score: number;
  /** True when this candidate won (argmax). Tie-breaking by candidate order. */
  is_winner: boolean;
}

/**
 * Full result of a scoreCandidates call.
 *
 * `ranked`    — all candidates sorted descending by score.
 * `winner`    — the winning candidate (null only when candidates is empty).
 * `findings`  — diagnostic notes (unknown ops, absent facts that affected
 *               the result, etc.). Empty array on clean evaluation.
 * `op_used`   — the top-level op name of the score expression (observability).
 */
export interface ScoreCandidatesResult {
  ranked: CandidateResult[];
  winner: Candidate | null;
  findings: string[];
  op_used: string;
}

/**
 * Score every candidate in `surface` against `facts` using `decider`,
 * dispatching ops through `registry`.
 *
 * Pure: no I/O, no side effects, deterministic given the same inputs.
 *
 * @param surface   The selection-surface record (candidates array + decider ref).
 * @param facts     Observer facts to evaluate against.
 * @param decider   The decider program (score expression + accepts_trust).
 * @param registry  Op registry (default: builtinOps). Extend for custom ops.
 * @param stickyKey A stable string (e.g. observer_id + ":" + address) used by
 *                  sticky_hash for deterministic bucket assignment.
 */
export function scoreCandidates(
  surface: SelectionSurface,
  facts: ObserverFact[],
  decider: DeciderProgram,
  registry: OpRegistry = builtinOps,
  stickyKey: string = '',
): ScoreCandidatesResult {
  const findings: string[] = [];

  // N=0: empty candidate set — no winner possible.
  if (surface.candidates.length === 0) {
    console.log(
      `[run-experiments] decided address=${surface.address} winner=<none> via=<empty-set>`,
    );
    return { ranked: [], winner: null, findings: ['No candidates in surface.'], op_used: '<empty-set>' };
  }

  // Determine the top-level op name for observability.
  const scoreExpr = decider.score;
  const op_used: string =
    'op' in scoreExpr
      ? (scoreExpr as OpNode).op
      : 'fact_path' in scoreExpr
        ? 'fact_path'
        : 'const' in scoreExpr
          ? 'const'
          : 'candidate_scores' in scoreExpr
            ? 'candidate_scores'
            : 'split' in scoreExpr
              ? 'split'
              : 'unknown';

  // Check for unknown top-level op (warn in findings; fail-closed handled in evalExpr).
  if ('op' in scoreExpr) {
    const topOp = (scoreExpr as OpNode).op;
    if (!(topOp in registry)) {
      findings.push(`Unknown top-level op "${topOp}" — fail-closed (all candidates score 0.0).`);
    }
  }

  // Score each candidate.
  const scored: CandidateResult[] = surface.candidates.map((candidate) => {
    // Build the evaluation context. We attach the registry via a hidden
    // property on ctx so evalExpr can dispatch without a closure parameter.
    const ctx: ScoreContext & { _registry: OpRegistry } = {
      candidates: surface.candidates,
      candidate,
      facts,
      decider,
      stickyKey,
      evalExpr,
      _registry: registry,
    };

    const rawScore = evalExpr(scoreExpr, ctx);
    const score = Math.max(0, Math.min(1, rawScore));
    return { candidate_id: candidate.candidate_id, score, is_winner: false };
  });

  // Rank descending by score; tie-break by original candidate order (stable).
  const ranked = [...scored].sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    // Stable: preserve insertion order (index in original candidates array).
    return (
      surface.candidates.findIndex((c) => c.candidate_id === a.candidate_id) -
      surface.candidates.findIndex((c) => c.candidate_id === b.candidate_id)
    );
  });

  // Mark winner (first in ranked = highest score + earliest in original order on tie).
  ranked[0].is_winner = true;
  const winnerCandidate =
    surface.candidates.find((c) => c.candidate_id === ranked[0].candidate_id) ?? null;

  console.log(
    `[run-experiments] decided address=${surface.address} winner=${ranked[0].candidate_id} via=${op_used}`,
  );

  return { ranked, winner: winnerCandidate, findings, op_used };
}
