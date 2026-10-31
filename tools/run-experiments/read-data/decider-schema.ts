// tools/run-experiments/read-data/decider-schema.ts
//
// Purpose: Machine-readable score-expression schema for decider programs, plus
// `validateDecider`. A decider program is a DATA record — a tree of
// score-expression nodes (ScoreExpr) that the evaluator traverses via an
// extensible capability registry. No strategy enum, no closed op list.
//
// Non-negotiable invariants:
//   - `op` is an open string. The registry (not this file) owns the dispatch
//     table. This file validates structure; it does NOT enumerate valid ops.
//     An op absent from the registry fails closed at evaluation time (T1).
//   - `accepts_trust` is a list of open `trust:*` descriptor ref strings.
//     NOT a fixed class enum. A decider reads only facts whose trust_ref
//     matches its accepts_trust list. The evaluator enforces this; the schema
//     records it.
//   - No string-encoded compound predicates (e.g. "utm==youtube" is banned).
//     Every operand is a structured node: {op, ...} | {fact_path} | {const} |
//     {candidate_scores} | {split}.
//   - Unknown op at validation time = rejected (fail-closed). The validated
//     op set is supplied by the caller (the same registry keys used at eval).
//     This keeps the schema open without losing the validation safety net.
//   - All numeric weights/scores are DATA (in the record), never code constants.
//
// Dependencies: pure — zero I/O imports.

// ---------------------------------------------------------------------------
// Score expression node tree (self-describing, structured — not string-encoded)
// ---------------------------------------------------------------------------

/**
 * A reference to a fact at a data path in the observer's fact stream.
 * `path` is an array of string segments — never a dot-encoded string.
 */
export interface FactPathNode {
  fact_path: string[];
}

/**
 * A literal constant value (string, number, boolean, or null).
 */
export interface ConstNode {
  const: string | number | boolean | null;
}

/**
 * Per-candidate score assignment.
 * Keys are candidate_id strings; values are scores (typically 0.0..1.0).
 * An absent candidate receives a neutral score of 0.5 (not a failure).
 */
export interface CandidateScoresNode {
  candidate_scores: Record<string, number>;
}

/**
 * Traffic-split weights by candidate_id.
 * Values are relative weights (need not sum to 1 — the evaluator normalises).
 * Used by the `sticky_hash` op: a stable hash of the observer_id determines
 * which bucket the observer falls into, then that bucket's candidate is chosen.
 */
export interface SplitNode {
  split: Record<string, number>;
}

/**
 * One case in a `case` expression.
 * `when` is the condition (any ScoreExpr that produces a boolean-ish result).
 * `then` is the score expression to evaluate when `when` is truthy.
 */
export interface CaseClause {
  when: ScoreExpr;
  then: ScoreExpr;
}

/**
 * A generic operator node. `op` is an open string (registry key).
 * Additional fields are op-specific — the evaluator reads them via the
 * registered op handler. Common shapes:
 *
 *   eq:         { op: "eq", left: ScoreExpr, right: ScoreExpr }
 *   lt / gt:    { op: "lt", left: ScoreExpr, right: ScoreExpr }
 *   and / or:   { op: "and", operands: ScoreExpr[] }
 *   not:        { op: "not", operand: ScoreExpr }
 *   case:       { op: "case", cases: CaseClause[], default: ScoreExpr }
 *   sticky_hash:{ op: "sticky_hash", of: FactPathNode, split: SplitNode }
 *   outcome:    { op: "outcome", metric: string, candidate_id: ScoreExpr }
 *
 * Future ops are registered as leaf capabilities — zero schema change here.
 */
export interface OpNode {
  op: string;
  [key: string]: unknown;
}

/**
 * A score expression is a union of the node shapes above.
 * The evaluator dispatches on the presence of the discriminant field:
 *   "fact_path"        → FactPathNode
 *   "const"            → ConstNode
 *   "candidate_scores" → CandidateScoresNode
 *   "split"            → SplitNode
 *   "op"               → OpNode (registry dispatch)
 */
export type ScoreExpr =
  | FactPathNode
  | ConstNode
  | CandidateScoresNode
  | SplitNode
  | OpNode;

// ---------------------------------------------------------------------------
// Decider program record (entity: "decider")
// ---------------------------------------------------------------------------

/**
 * A fully specified decider program.
 *
 * `decider_id`    — stable identifier; used as the `decider_program_ref` in a
 *                   selection-surface record.
 * `score`         — the root ScoreExpr evaluated per candidate.
 * `accepts_trust` — open list of `trust:*` descriptor refs this program will
 *                   read. Facts whose trust_ref is NOT in this list are
 *                   treated as absent (neutral score). Open: any descriptor
 *                   ref a user mints is valid here.
 * `label`         — optional human-readable name (UI only; never in engine logic).
 */
export interface DeciderProgram {
  entity_type: 'decider';
  decider_id: string;
  score: ScoreExpr;
  accepts_trust: string[];
  label?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Result of `validateDecider`. On failure, `errors` lists every problem found
 * (not just the first) so callers can surface all issues at once.
 */
export interface DeciderValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Recursively collect every `op` string referenced in a ScoreExpr tree.
 * Used by `validateDecider` to check that all ops are in the known registry.
 */
function collectOps(expr: ScoreExpr, into: Set<string>): void {
  if ('op' in expr) {
    into.add((expr as OpNode).op);
    // Recurse into known structural sub-fields.
    const node = expr as Record<string, unknown>;
    for (const key of ['left', 'right', 'operand', 'of', 'default']) {
      if (node[key] != null) collectOps(node[key] as ScoreExpr, into);
    }
    if (Array.isArray(node['operands'])) {
      for (const o of node['operands'] as ScoreExpr[]) collectOps(o, into);
    }
    if (Array.isArray(node['cases'])) {
      for (const c of node['cases'] as CaseClause[]) {
        collectOps(c.when, into);
        collectOps(c.then, into);
      }
    }
  }
  // FactPathNode, ConstNode, CandidateScoresNode, SplitNode have no sub-exprs.
}

/**
 * Validate a DeciderProgram record against the set of known op names.
 *
 * `knownOps` — the set of op strings registered in the evaluator registry
 *              (the registry keys from OpRegistry in score-candidates.ts).
 *              Passing an empty set skips op validation (useful for schema-
 *              shape-only checks in callers that don't have a registry).
 *
 * Checks performed:
 *   1. entity_type === "decider"
 *   2. decider_id is a non-empty string
 *   3. score is present and is a valid ScoreExpr root (has at least one
 *      discriminant field: op / fact_path / const / candidate_scores / split)
 *   4. accepts_trust is an array of non-empty strings
 *   5. Every op referenced in the score tree is in knownOps (if knownOps non-empty)
 *   6. No string-encoded compound values (discriminant fields must be typed, not
 *      opaque strings — e.g. fact_path must be string[], not "a.b.c")
 */
export function validateDecider(
  record: unknown,
  knownOps: Set<string> = new Set(),
): DeciderValidationResult {
  const errors: string[] = [];

  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['Decider record must be a non-null object.'] };
  }

  const r = record as Record<string, unknown>;

  // 1. entity_type
  if (r['entity_type'] !== 'decider') {
    errors.push(`entity_type must be "decider"; got ${JSON.stringify(r['entity_type'])}.`);
  }

  // 2. decider_id
  if (typeof r['decider_id'] !== 'string' || r['decider_id'].trim().length === 0) {
    errors.push('decider_id must be a non-empty string.');
  }

  // 3. score presence and root discriminant
  if (r['score'] == null) {
    errors.push('score is required.');
  } else if (typeof r['score'] !== 'object' || Array.isArray(r['score'])) {
    errors.push('score must be a ScoreExpr object node.');
  } else {
    const scoreNode = r['score'] as Record<string, unknown>;
    const hasDiscriminant =
      'op' in scoreNode ||
      'fact_path' in scoreNode ||
      'const' in scoreNode ||
      'candidate_scores' in scoreNode ||
      'split' in scoreNode;
    if (!hasDiscriminant) {
      errors.push(
        'score root node must have at least one discriminant field: op, fact_path, const, candidate_scores, or split.',
      );
    }

    // 4a. fact_path must be string[] not a dot-encoded string
    if ('fact_path' in scoreNode) {
      if (!Array.isArray(scoreNode['fact_path'])) {
        errors.push('fact_path must be an array of strings, not a dot-encoded string (L: machine-readable).');
      } else {
        const fp = scoreNode['fact_path'] as unknown[];
        if (fp.some((s) => typeof s !== 'string')) {
          errors.push('fact_path elements must all be strings.');
        }
      }
    }

    // 5. Unknown op check (only when knownOps is non-empty)
    if (knownOps.size > 0) {
      const usedOps = new Set<string>();
      collectOps(r['score'] as ScoreExpr, usedOps);
      for (const op of usedOps) {
        if (!knownOps.has(op)) {
          errors.push(`Unknown op "${op}" — not in the evaluator registry. Register a leaf or fix the decider.`);
        }
      }
    }
  }

  // 4. accepts_trust
  if (!Array.isArray(r['accepts_trust'])) {
    errors.push('accepts_trust must be an array of trust descriptor ref strings.');
  } else {
    const at = r['accepts_trust'] as unknown[];
    for (let i = 0; i < at.length; i++) {
      if (typeof at[i] !== 'string' || (at[i] as string).trim().length === 0) {
        errors.push(`accepts_trust[${i}] must be a non-empty string.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
