# content-gate/read-data

Shared type definitions for the content-gate primitive - no runtime code, pure TypeScript exports.

## Files

| File | Purpose |
|------|---------|
| `gate-types.ts` | All types: ContentBlock, GateSubject, GateSpec, GateRule, Finding, FindingLocator, RuleResult, GateResult |
| `build-copy-subject.ts` | Generic helpers: `textBlocksToSubject(blocks)` and `plainTextToSubject(text)` — construct a GateSubject from raw block arrays or a plain string |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `ContentBlock` | `{ kind: string; text: string; [k]: unknown }` | Open-kind content unit |
| `GateSubject` | `{ blocks: ContentBlock[] }` | Input to the engine |
| `OutcomePolicy` | `{ gating: boolean; label?: string }` | Maps an open outcome string to gating behavior; engine defaults: block→gating, warn→non-gating |
| `GateRule` | `{ id, evaluator, config, weight?, outcome?, message? }` | One DATA-configured rule; `outcome` is open string (default "block") |
| `GateSpec` | `{ id, label?, min_score?, rules, outcome_policies? }` | Full gate definition supplied as DATA; `outcome_policies` overrides/extends engine defaults |
| `FindingLocator` | `{ block_index?, kind?, offset?, match? }` | Fine-grained position: `block_index` is the exact block, `offset` is within that block's text |
| `Finding` | `{ rule_id, evaluator, outcome, message, locator?, suggested_replacement? }` | One diagnostic item; `suggested_replacement` present when rule config supplies a `replacement` string |
| `RuleResult` | `{ rule_id, evaluator, score, weight, outcome, findings }` | Per-rule evaluation outcome |
| `GateResult` | `{ gate_id, passed, score, rule_results, findings }` | Engine output |
| `textBlocksToSubject` | `(blocks: Array<{kind?,text,...}>) => GateSubject` | Converts raw block array to GateSubject; drops empty-text blocks; defaults kind to "text"; forwards extra props |
| `plainTextToSubject` | `(text: string) => GateSubject` | Wraps a single string as a one-block GateSubject with kind "text" |

## Dependencies

**Depends on:** nothing

**Depended on by:** `do-work/evaluator.ts`, `do-work/evaluate-gate.ts`, `do-work/standard-evaluators.ts`, `__tests__/*`
