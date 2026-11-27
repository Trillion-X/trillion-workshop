# tools/keep-package-files-current/

Keeps the Workshop's `package-files.json` at origin/main, every five minutes. A tool row's program is laid out with the files that package-files.json names for it; when that file falls behind the tree, a run stops with "Cannot find module" (tool:sales-contracts and the two said-done tools, Nov 20 2026). This pass brings it up to date and lands only the changes it can explain. It never blocks a push.

## What one pass does

1. Fetches origin and reads origin/main.
2. Finds the last commit on origin/main that changed package-files.json, and the paths changed since.
3. Regenerates the file from an export of origin/main with `test-helpers/write-package-files.mjs`.
4. Compares the generated file with origin's file, row by row and item by item. The job only adds (the rules below); origin's file is the base, so a hand patch on origin is never undone:
   - a row or item the generator finds that origin lacks: added to origin's file;
   - an origin row or item the generator does not find: kept, and returned as a finding (a generator that misses a still-imported package is a generator bug, not a reason to drop it).
5. If nothing is added, it stops (`nothing-to-do`); findings are still returned.
6. If origin moved while the generator ran, it lands nothing (`origin-moved`); the next pass starts again from the new tip.
7. Otherwise it hands origin's file with the additions to the landing seam. Landing is not wired: the landing owner (land_paths.py) lands the working copy's bytes, and writing the checkout belongs to its owner. Until that is granted, the pass reports `error` and lands nothing.

## Output

One JSON line on stdout: `outcome` (`nothing-to-do`, `landed`, `origin-moved` or `error`), `at`, `added`, `findings`, `commit` and `why`.

## Files

| File | Purpose |
|------|---------|
| `do-work/keep-package-files-current.mjs` | `classify` (the rule), `keepPackageFilesCurrent({ root, seams })` (one pass) and `realSeams` (git and the generator). |
| `test/keep-package-files-current.test.mjs` | The pass with fake seams: adds land on top of origin's file; a missing origin item is kept and is a finding; nothing to add lands nothing and still records findings; origin moving mid-run lands nothing; a row origin has and the generator lacks is a finding, never removed; an unwired landing lands nothing. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:keep-package-files-current`, a `computer` run with `change-a-folder` and `start-a-program`, and its wake `every-five-minutes` (every 5 minutes, UTC). |
| `part.json` | The pass is public. |

## Run the tests

```
env -u GIT_INDEX_FILE node --test tools/keep-package-files-current/test/keep-package-files-current.test.mjs
```

## Why

Rows were landed without their entries in package-files.json, and a regeneration was refused on a file a moved tool still named. A fix made by hand each time needs a person. This pass is the same regeneration run by the engine on the Mac that holds the checkout, and it refuses to drop what it cannot explain.
