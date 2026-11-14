# content-gate/do-work

Engine and evaluators for the content-gate primitive - pure TypeScript, no framework, no I/O.

## Files

| File | Purpose |
|------|---------|
| `evaluator.ts` | Evaluator function type and EvaluatorRegistry type |
| `evaluate-gate.ts` | Generic gate engine: registry lookup, weighted score, outcome-policy DATA map for gating determination, fail-closed on unknown evaluator or unknown outcome |
| `standard-evaluators.ts` | Four built-in DATA-configured evaluators: pattern, required-kinds, kind-order, length-bound |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `Evaluator` | `(subject: GateSubject, rule: GateRule) => { score: number; findings: Finding[] }` | Pure evaluation function contract |
| `EvaluatorRegistry` | `Record<string, Evaluator>` | The sole dispatch table |
| `EvaluatorOutput` | `{ score: number; findings: Finding[] }` | Return type of every evaluator |

## Key Functions

| Export | Signature | Role |
|--------|-----------|------|
| `evaluateGate` | `(subject, spec, registry) => GateResult` | Run a gate spec against a subject; gating is resolved from `spec.outcome_policies` merged with engine defaults — never a hardcoded outcome string compare |
| `standardEvaluators` | `EvaluatorRegistry` | Default capability pack of four evaluators; extend with `{ ...standardEvaluators, 'ai-quality': fn }` |

## Outcome policy

The engine ships two built-in defaults: `block` (gating) and `warn` (non-gating). Any `GateSpec` may override these or register new outcome names via `outcome_policies`. An outcome absent from the merged map fails closed (gating). The engine never compares a literal `"block"` string — all gating logic flows through `isGating(outcome, policies)`.

## Dependencies

**Depends on:** `read-data/gate-types.ts`

**Depended on by:** callers passing subject + spec + registry; `__tests__/*`
