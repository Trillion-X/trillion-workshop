# ui/read-data — pure source-analysis guards for the shared UI substrate

Pure, I/O-free analysis functions that structurally guard the `ui` package (and its consumers) against whole defect classes — each guard exists because a real shipped incident proved review vigilance alone does not hold the line.

## Files

| File | Purpose |
|------|---------|
| `reexport-binding-lint.ts` | Scanner for the b277 crash class (2026-07-10): `export { x } from '…'` creates NO local binding, so a module that also USES `x` in its own code throws `ReferenceError` at runtime — esbuild bundles it silently, scoped tsc greps hide it, and the crash is often content-gated so empty-state probes pass. Pure text analysis (comments/strings/import-export lines stripped); pure barrels can never false-positive. |
| `reexport-binding-lint.test.ts` | Unit tests (the exact b277 fixture shape, the fix shape, barrel/comment/type-only negatives) + a REPO SWEEP failing CI if any board-lane package (`ui`, `group`, `vision-board`, `documents`, `content-actions`) reintroduces the class. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `findReexportBindingViolations` | `(source: string) → ReexportBindingViolation[]` | Empty array = clean; each violation names the re-exported-but-unbound symbol and its use count in the module's own code. |
| `ReexportBindingViolation` | `{ name: string, uses: number }` | One unbound-symbol finding. |

## Dependencies

**Depends on:** nothing (pure string analysis; the test file uses `node:fs` to sweep the repo).

**Depended on by:** the vitest suite (structural CI guard). Any package may import the scanner to add its own sweep.
# tools/ui/read-data/

Files more than one moved group imports, kept once.

Moved here byte for byte from bitfield-packages by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. bitfield-packages imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.
