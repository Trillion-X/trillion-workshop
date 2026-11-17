// packages/content-gate/do-work/evaluator.ts
//
// Purpose: The Evaluator function contract and EvaluatorRegistry type.
// An Evaluator is a pure function: subject + rule → score (0..100) + findings.
// The registry is the ONLY dispatch table — the engine never branches on
// evaluator identity (L090, enum-dissolution).
//
// Non-negotiable invariants:
//  - Evaluators are pure: no I/O, no side effects, deterministic output.
//  - Score is always in [0, 100].
//  - Findings reference the rule that produced them via rule_id / evaluator.
//  - Adding a new evaluator = add one entry to the registry map. Zero engine change.

import type { Finding, GateRule, GateSubject } from '../read-data/gate-types';

/** Return type of every evaluator function. */
export interface EvaluatorOutput {
  /** 0..100. 100 = rule fully satisfied; 0 = rule completely violated. */
  score: number;
  /** All diagnostics produced for this rule. Empty when score === 100. */
  findings: Finding[];
}

/**
 * A pure, DATA-driven evaluation function.
 * Receives the full subject and the rule (including opaque `rule.config`).
 * Returns a score 0..100 and any findings.
 */
export type Evaluator = (subject: GateSubject, rule: GateRule) => EvaluatorOutput;

/**
 * Registry map from evaluator name (string key) to its implementation.
 * This is the ONLY dispatch table in the system — the engine does:
 *   const fn = registry[rule.evaluator];
 * and never branches on the evaluator name itself.
 */
export type EvaluatorRegistry = Record<string, Evaluator>;
