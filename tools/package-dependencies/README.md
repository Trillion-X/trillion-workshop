# tools/package-dependencies/

Relation, rule, projection and owner-action intent descriptors for packages, and the fold that turns owner-fed records and process-session proofs into caller-ready projection data. Moved here byte for byte from bitfield-packages `packages/package-dependencies`, where the Workshop held nothing of it. This folder is a prepared restore: the files are the originals and are not yet wired to a tool row.

## Files moved from bitfield-packages (packages/package-dependencies)

Each file below is the package's own, byte for byte; `moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `parts/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `data/relation-projection-fixtures.json` | A file of the package. |
| `do-work/create-owner-action-intent.ts` | A file of the package. |
| `processes/fold-process-proof.mjs` | A file of the package. |
| `processes/fold-relation-projection.mjs` | A file of the package. |
| `read-data/read-relation-projection.ts` | A file of the package. |
| `tests/owner-action-intent.test.ts.held` | A test of the package, held: imports react or shared ui parts (@/packages/ui) that live in apps parts/ui, not in the Workshop |
| `tests/process-proof-fold.test.mjs.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |
| `tests/relation-projection.test.mjs.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |

### Not carried

- 6 files: package README, package.json or ignore file; this folder has its own README
- 2 files: proof evidence of the package (screenshots, proof scripts and notes); not carried
- 1 file: maps package entries to the retired package runtime's entry scope; not carried
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried

The receipt's `not_carried` names each path.
