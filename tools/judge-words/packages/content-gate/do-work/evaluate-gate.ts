// packages/content-gate/do-work/evaluate-gate.ts
//
// Purpose: The generic content-gate engine. Takes a GateSubject, a GateSpec,
// and an EvaluatorRegistry and returns a GateResult.
//
// Non-negotiable invariants:
//  - NEVER branches on rule.evaluator (no switch, no if-chains on the string).
//    Registry lookup is the ONLY dispatch path (L090).
//  - Unknown evaluator = fail-closed: score 0, outcome "block" finding.
//    NEVER throws — a missing evaluator is a DATA error, not a crash.
//  - weighted score = Sum(score * weight) / Sum(weight); 100 when no rules.
//  - passed = (no gating rule scored < 100) AND score >= (spec.min_score ?? 0).
//  - Whether an outcome is gating is resolved via the outcome-policy DATA map
//    (spec.outcome_policies merged over engine defaults). An unknown outcome
//    fails closed (gating: true). NEVER compare a literal "block" string.

import type { EvaluatorRegistry } from '@/packages/content-gate/do-work/evaluator';
import type {
  Finding,
  GateResult,
  GateRule,
  GateSpec,
  GateSubject,
  OutcomePolicy,
  RuleResult,
} from '@/packages/content-gate/read-data/gate-types';

const DEFAULT_WEIGHT = 1;
const DEFAULT_OUTCOME = 'block';

/**
 * Engine built-in outcome policies.
 * Fully overridable and extendable via GateSpec.outcome_policies.
 * An outcome absent from the merged map fails closed (gating: true).
 */
const DEFAULT_OUTCOME_POLICIES: Record<string, OutcomePolicy> = {
  block: { gating: true, label: 'Block' },
  warn: { gating: false, label: 'Warning' },
};

/**
 * Merge the engine defaults with any spec-level overrides.
 * Spec entries win (callers may redefine "block" itself if needed).
 */
function buildPolicies(
  spec: GateSpec,
): Record<string, OutcomePolicy> {
  return { ...DEFAULT_OUTCOME_POLICIES, ...(spec.outcome_policies ?? {}) };
}

/**
 * Determine whether an outcome is gating (i.e. a rule with this outcome must
 * score 100 for the gate to pass).
 * Unknown outcomes fail closed (gating: true) — consistent with the
 * fail-closed philosophy for unknown evaluators.
 */
function isGating(outcome: string, policies: Record<string, OutcomePolicy>): boolean {
  return policies[outcome]?.gating ?? true;
}

/** Sentinel finding emitted when the registry has no entry for a rule's evaluator. */
function unknownEvaluatorFinding(rule: GateRule): Finding {
  return {
    rule_id: rule.id,
    evaluator: rule.evaluator,
    outcome: 'block',
    message: `Unknown evaluator "${rule.evaluator}" — rule "${rule.id}" failed closed.`,
  };
}

/**
 * Evaluate a GateSubject against a GateSpec using the provided registry.
 * Returns a fully-populated GateResult.
 */
export function evaluateGate(
  subject: GateSubject,
  spec: GateSpec,
  registry: EvaluatorRegistry,
): GateResult {
  // Empty spec — gate trivially passes with score 100.
  if (spec.rules.length === 0) {
    return {
      gate_id: spec.id,
      passed: true,
      score: 100,
      rule_results: [],
      findings: [],
    };
  }

  const policies = buildPolicies(spec);

  const ruleResults: RuleResult[] = spec.rules.map((rule): RuleResult => {
    const outcome = rule.outcome ?? DEFAULT_OUTCOME;
    const weight = rule.weight ?? DEFAULT_WEIGHT;

    // Registry lookup — the ONLY dispatch. No branch on rule.evaluator name.
    const evaluator = registry[rule.evaluator];

    if (evaluator === undefined) {
      // Fail-closed: unknown evaluator produces score 0 + a block finding.
      // Always "block" regardless of rule.outcome — a missing evaluator is a
      // code-contract violation, not a policy choice.
      const finding = unknownEvaluatorFinding(rule);
      return {
        rule_id: rule.id,
        evaluator: rule.evaluator,
        score: 0,
        weight,
        outcome: 'block',
        findings: [finding],
      };
    }

    const output = evaluator(subject, rule);

    // Stamp rule_id + evaluator onto each finding.
    // Preserve the finding's own outcome if the evaluator set one;
    // otherwise inherit the rule's outcome.
    const findings: Finding[] = output.findings.map((f) => ({
      ...f,
      rule_id: rule.id,
      evaluator: rule.evaluator,
      outcome: f.outcome ?? outcome,
    }));

    return {
      rule_id: rule.id,
      evaluator: rule.evaluator,
      score: output.score,
      weight,
      outcome,
      findings,
    };
  });

  // Weighted average score.
  let weightSum = 0;
  let scoreSum = 0;
  for (const r of ruleResults) {
    weightSum += r.weight;
    scoreSum += r.score * r.weight;
  }
  const score = weightSum === 0 ? 100 : scoreSum / weightSum;

  // Pass condition: no gating rule scored < 100, AND score >= min_score.
  // isGating() reads the policy map — never compares a literal outcome string.
  const minScore = spec.min_score ?? 0;
  const noGatingRuleFailed = ruleResults.every(
    (r) => !isGating(r.outcome, policies) || r.score >= 100,
  );
  const passed = noGatingRuleFailed && score >= minScore;

  const findings: Finding[] = ruleResults.flatMap((r) => r.findings);

  return {
    gate_id: spec.id,
    passed,
    score,
    rule_results: ruleResults,
    findings,
  };
}
