# content-production/do-work/

**Purpose:** Write-path executables for the content-production package — run submission plus the content-pipeline capability executables that workflow actions run through `compute.process`.

## Files

| File | Purpose |
|------|---------|
| `submit-content-production-run.ts` | Builds + sends the run-submission workflow request (`action:submit-content-production-run`) |
| `validate-recipe.mjs` | T01 conformance validator: asserts a recipe is a valid NATIVE workflow-definition record (see `../recipe-conformance.md`) |
| `media-classify.mjs` | T06 style selector: manual / rule (`../classify-rules.json`) / ai (local CLI) — zero style names in code |
| `generate-derived.mjs` | T07 deliverable generator: format specs are DATA in `../derived-formats.json`; local CLI only |
| `__tests__/` | node:test suites for every executable above (see its README) |

## Key Functions

| Export / CLI | Signature / Shape | Role |
|--------------|-------------------|------|
| `validateRecipe(payload)` | `(object) => {ok, findings[]}` | Pure payload conformance check |
| `validateRecipeRecord(record)` | `(record) => {ok, findings[]}` | Wrapper + path check + `[recipe.validate]` log |
| `media-classify.mjs` | `--shape <json> [--mode rule\|ai\|manual] [--rules <file>] [--definition id] [--definitions a,b]` | Emits `{definition, mode, shape}` JSON |
| `generate-derived.mjs` | `--format <id> --transcript <file> --out <file> [--formats <file>] [--cli <argv json>]` | Writes the deliverable; emits `{format, content_type, output, chars}` |

## Invariants

- Capability executables never name a style/format/platform — those are DATA rows in the package root JSON files.
- AI calls go through the LOCAL CLI only (no HTTP API keys) — argv itself is overridable data.
- Every executable prints a machine-readable JSON report as its last stdout line.

## Dependencies

**Depends on:** node:child_process/fs/path only (zero npm deps); `../classify-rules.json`, `../derived-formats.json`, the package boundary `../things-to-store-and-run.json` (conformance fixtures).
**Depended on by:** the `action:media-classify` / `action:generate-derived` workflow-definition records (argv references), `__tests__/`, and `../__tests__/` (golden + falsification + trigger suites import `validate-recipe.mjs`).
