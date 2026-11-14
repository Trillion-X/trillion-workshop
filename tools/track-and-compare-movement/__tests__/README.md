# motion-analysis/__tests__/

Contract tests over the `motion-analysis` package boundary DATA.

## Files

| File | Purpose |
|---|---|
| `ingest-reference-action.test.mjs` | Proves the `ingest-reference` workflow action is well-formed, that its steps resolve the files and actions they name, and that the package DATA freezes no host path and authors no contextual partition key. |

## Key checks

| Check | Shape | Role |
|---|---|---|
| every thing has a distinct address | scans `manifest.things` | two things claiming one address is a silent overwrite |
| no workflow definition authors the contextual `partition_key` | scans every `kind: action` | workflow-core overwrites it unconditionally, so an authored value can only name the wrong app |
| action writes, runs two compute processes, then loops | locates steps by ROLE | ordering invariant that survives new steps being inserted |
| perception step fails closed on a missing host vendor root | matches the `${VAR:?}` shell guard | asserts the property, deliberately NOT the variable's name |
| record-maker argv names only files it actually mounts | resolves argv against declared mounts | a renamed or unmounted script fails whatever it is called |
| loop target resolves to an action this package defines | resolves `definition_id` | catches the writer being deleted or renamed away |
| no host path is frozen anywhere in the package DATA | sweeps the whole manifest | where a file lives is the host's property |

## Why this design

The suite was a SNAPSHOT until 2026-09-05: 18 frozen sha256 hashes plus an assertion that the
package held exactly 19 things. That shape asserts "nothing may ever change", so it failed on every
later addition and said nothing about whether the addition was correct. By the time it was rewritten
the package held 44 things and 6 of 10 checks were red, **none of them a real defect**.

Three checks are now strictly stronger than the literals they replaced, because they RESOLVE
references instead of matching text. A frozen string stops checking anything the moment it goes
stale; a resolution keeps checking after every rename.

One check is deliberately narrower than it could be. The domain-word sweep is scoped to the ingest
action rather than the whole manifest, because the manifest legitimately discusses sports in two
contract descriptions that exist to forbid them as package concepts, and because it carries a real
leak of that rule at its `match-stats-view` input descriptor. That leak is gated source DATA and is
recorded at
`ai-command-center/notes/knowledge/package-mechanisms/an-input-descriptor-default-is-where-a-domain-name-hides.md`
rather than asserted away here.

## Dependencies

**Depends on:** `../things-to-store-and-run.json` (the only input; the suite reads DATA and imports
no package source), `node:test`, `node:assert/strict`.
**Depended on by:** nothing. This is a leaf suite.

## Running it

`node --test <absolute path to this folder>/ingest-reference-action.test.mjs`

Name the FILE, not the folder. `node --test <directory>` resolves the directory as a module here
and reports a single failing test with `MODULE_NOT_FOUND`, which reads like a broken suite rather
than a wrong invocation.
