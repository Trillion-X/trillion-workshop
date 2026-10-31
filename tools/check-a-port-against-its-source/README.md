# tools/check-a-port-against-its-source/

Checks a contract for work taken from a reference: a source ported, a behaviour ported, a visual replica, an inspiration or an anti-reference. It verifies the declared source, baseline, target, preserved mechanisms and, for a replica, the measured geometry and the pixel difference, without knowing which application uses the contract. Ported from the package `reference-adaptation-contract`.

All contract, source, picture and comparison identities are the BLAKE3 identity `1f:<64 hex>` of `tools/content-identity`, the one owner. Application identity, source paths, target paths and adaptation choices stay DATA in the contract the person gives.

## Files

| File | Purpose |
|------|---------|
| `do-work/validate-reference-adaptation-contract.mjs` | The validator: `validateReferenceAdaptationContract(contract, { stage, target })` and the same as a command. Changed from the package in two places only: the identity comes from `tools/content-identity` instead of the old runtime's slot protocol, and the schema names no longer carry the old product word, with the two legacy schema names dropped. |
| `do-work/check-my-reference-contract.mjs` | `tool:check-a-reference-adaptation-contract`: the granted folder in argv (the validator reads the contract's paths relative to it), the input on standard input, `{ result }` on the last line. |
| `part.json` | The validator is public, so another tool may import it. |
| `tool-rows.json` | The row. It runs on the person's computer after they grant `read-a-folder`, and packs `tools/content-identity` with its BLAKE3 module. |
| `test/validate-reference-adaptation-contract.test.mjs` | The package's test: source-first, visual replica, adversarial, fuzz, determinism, the command, and the golden contract. Its pictures are made in the test. The package's test of the package-owned schema is the same check as the first test now that the old schema names are gone; both are kept. |
| `test/check-my-reference-contract-row.test.mjs` | The row's shape, and the command run the way the engine runs it over a made-up folder. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `validateReferenceAdaptationContract` | `(contract, { stage?, target? }) -> { valid, errors, id, mode, status, measurements }` | Never throws on a malformed contract: it returns errors in words. `stage` is `pre-edit` or `completion` (the default). |
| Contract | `{ schema, id: "REF-...", status, directive, mode, sources, targets, preserve, allowed_deltas, banned_substitutions, baseline, proof }` | Mode is `SOURCE_FIRST_PORT`, `BEHAVIORAL_PORT`, `VISUAL_REPLICA`, `INSPIRATION_ONLY` or `ANTI_REFERENCE`. A copy directive cannot be relabelled inspiration. |
| Pixel lock | `{ schema, references, target_screens }` | The measured geometry a visual replica must carry: landmarks, colour samples, typography, spacing, surfaces, controls and element mappings, with minimums. At completion the pixel difference is measured from the pictures and may not exceed three percent. |

## Dependencies

**Depends on:** `tools/content-identity` (BLAKE3), Node's `zlib`.

**Depended on by:** `tool-rows.json`. The local engine runs the row on the person's computer (`computer` kind) after the person grants `read-a-folder`.
