# data/

**Purpose:** Example DATA records that configure the evaluator (deciders, signal descriptors, registry configs).

## Files

| File | Purpose |
|------|---------|
| `decider-bandit.example.json` | Example decider program: pure DATA. Shifts to highest-outcome candidate, cold-start to sticky_hash split. Demonstrates `case` op with `outcome` condition (Wave-2, T10). |

## Key Insights

- **All configurations are DATA, not code.** A new decider = 1 JSON record. A new signal = 1 descriptor entry. A new op source = 1 registry entry (in code) + many DATA instantiations.
- **`decider-bandit.example.json` is pure DATA.** It uses ONLY existing built-in ops (`case`, `outcome`, `sticky_hash`). ZERO code changes. It demonstrates that bandit selection is achieved through DATA configuration + existing evaluators (L090, L063).
- **Outcome op is smart.** It reads `['candidate','outcome',metric,candidate_id]` facts automatically. The bandit decider doesn't know metric names — they come from DATA.

## Non-Negotiable Invariants

1. **No hardcoded values in code.** Decider programs, signal lists, signal extractors, op precedence = all DATA.
2. **Generic handler, parameterized by DATA.** The evaluator is 100% generic. Each new use case is a new DATA record.
3. **Opaque EXCEPT at boundaries.** The package doesn't know what metrics the bandit tracks, what sources identity uses, or which signals matter. The DATA tells the package (L098).
