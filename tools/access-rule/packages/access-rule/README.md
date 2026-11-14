# Access Rule

Access Rule owns a package source proposal for universal rule evaluation:
subject descriptor + target descriptor + operation descriptor + rule records +
evidence refs -> result records + proof rows + owner handoff descriptors.

The package source lives here as implementation proposal material. Live app truth
is the selected Runtime Kit log fold after the package proposal importer or live
owner write path records it.

## Boundary

- Owns generic rule evaluation records, request/result materialization, proof
  rows, handoff descriptors, and receipt records.
- Reuses EEAF-style fact records, workflow definitions, owner-action contracts,
  process/session descriptors, and maintained record projections.
- Does not own EEAF internals, workflow internals, direct process spawning,
  adjacent owner policy, or renderer policy.
- Does not create a slot. Runtime Kit stays a blind record/router/process
  substrate.

## Current Backend Shape

The active backend shape is generic:

- `subject_descriptor`
- `target_descriptor`
- `operation_descriptor`
- `rule_record`
- `evidence_ref`
- `evaluation_request`
- `evaluation_result`
- `handoff_descriptor`
- `receipt_record`

Result labels and business words are data. A package set can use access,
customer, campaign, event, product, or future words without changing source
logic.

## Superseded Evidence

The Runtime Kit `tribes` package-set contains earlier access-rule evidence under
`~/.bitfield/runtime-kit/package-sets/tribes/packages/access-rule`. That folder
proved the package owner and stale shape. The active source here does not keep
the fixed request/property family from that evidence.

## Proof

```bash
cd /workspace/the-owner/dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/access-rule/tests/*.test.ts
npm --prefix packages/access-rule test
```

Current proof: both commands pass with 6 test files and 15 tests.
