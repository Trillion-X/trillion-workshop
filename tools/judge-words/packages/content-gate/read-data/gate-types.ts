// packages/content-gate/read-data/gate-types.ts
//
// Purpose: Shared type definitions for the content-gate primitive — the DATA
// shapes that flow between callers, the evaluator registry, and the engine.
// Framework-agnostic, zero runtime, pure type exports.
//
// Non-negotiable invariants:
//  - Block `kind` is an open string — callers name their own block kinds.
//    No enum. No switch. Any string is a valid kind.
//  - Evaluator names are open strings — the registry map is the ONLY
//    dispatch table. Engine never branches on evaluator identity (L090).
//  - `outcome` is an OPEN string — the rule data declares what outcome applies
//    (e.g. "block", "warn", "advisory", "auto_fix", "needs_review"). Whether
//    an outcome gates the pass is determined solely by the outcome-policy DATA
//    map, never by a hardcoded string comparison in the engine.
//  - All numeric scores are in [0, 100].

// ---------------------------------------------------------------------------
// Subject (the content being evaluated)
// ---------------------------------------------------------------------------

/** A single unit of composed content. `kind` is caller-defined (open string). */
export interface ContentBlock {
  kind: string;
  text: string;
  [key: string]: unknown;
}

/** The subject presented to the gate engine for evaluation. */
export interface GateSubject {
  blocks: ContentBlock[];
  /** Optional caller-supplied provenance/review evidence, interpreted by registered evaluators. */
  evidence?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Outcome policy (DATA — maps open outcome strings to gating behavior)
// ---------------------------------------------------------------------------

/**
 * Declares how a named outcome behaves.
 * `gating: true`  → a rule with this outcome must score 100 for the gate to pass.
 * `gating: false` → the rule is informational; its score does not block passage.
 * `label` is an optional human-readable name for display surfaces.
 *
 * The engine ships two built-in defaults:
 *   { block: { gating: true }, warn: { gating: false } }
 * Any GateSpec may override these or add new outcome names via `outcome_policies`.
 * An UNKNOWN outcome (no entry in the merged policy map) fails closed (gating: true).
 */
export interface OutcomePolicy {
  gating: boolean;
  label?: string;
}

// ---------------------------------------------------------------------------
// Spec (DATA — defined by callers, never hardcoded in the engine)
// ---------------------------------------------------------------------------

/**
 * One rule within a gate spec. `evaluator` names a key in the registry.
 * `outcome` is an open string — the pass/fail behavior for this outcome is
 * resolved via the spec's outcome_policies map (merged with engine defaults).
 * Omitting `outcome` defaults to "block".
 */
export interface GateRule {
  id: string;
  evaluator: string;
  config: Record<string, unknown>;
  weight?: number;
  outcome?: string;
  message?: string;
}

/** A complete gate specification. This is Society DATA — the engine reads it. */
export interface GateSpec {
  id: string;
  label?: string;
  min_score?: number;
  rules: GateRule[];
  /**
   * Open policy map that overrides or extends the engine's built-in defaults
   * ({ block: { gating: true }, warn: { gating: false } }).
   * Add new outcome names here to make them gating or non-gating.
   * Omit to accept the defaults.
   */
  outcome_policies?: Record<string, OutcomePolicy>;
}

// ---------------------------------------------------------------------------
// Results (produced by the engine)
// ---------------------------------------------------------------------------

/** Locator pointing to the specific position inside the subject that failed. */
export interface FindingLocator {
  block_index?: number;
  kind?: string;
  offset?: number;
  match?: string;
  /** Coordinate basis when a normalized text match cannot map to original text offsets. */
  offset_basis?: 'normalized';
}

/** One diagnostic produced by an evaluator for a specific rule. */
export interface Finding {
  rule_id: string;
  evaluator: string;
  /** Open string — resolved from GateRule.outcome (defaults to "block"). */
  outcome: string;
  message: string;
  locator?: FindingLocator;
  /**
   * When populated, the engine or an `auto_fix` outcome handler may apply
   * this replacement text at the locator position automatically.
   */
  suggested_replacement?: string;
}

/** Evaluation result for a single rule within a gate. */
export interface RuleResult {
  rule_id: string;
  evaluator: string;
  score: number;
  weight: number;
  /** Open string — resolved from GateRule.outcome (defaults to "block"). */
  outcome: string;
  findings: Finding[];
}

/** Top-level result returned by evaluateGate. */
export interface GateResult {
  gate_id: string;
  passed: boolean;
  score: number;
  rule_results: RuleResult[];
  findings: Finding[];
}
