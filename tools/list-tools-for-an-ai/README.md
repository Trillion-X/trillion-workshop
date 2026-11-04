# tools/list-tools-for-an-ai/

What an AI is told about a list of tools: the list shrunk to fit a character budget the AI names, each tool's description made to say what its hints say, whether a tool only reads or changes things, and which release of a published tool a given Trillion version runs. Four pure rows over synthetic input; no records door, no network.

## Files

| File | Purpose |
|------|---------|
| `read-data/tool-listing-budget.mjs` | `shownAt`, `listWithinBudget`, `listingMeta`, `withNamedInFull`: the list at levels full, brief, schema-only, names. Moved byte for byte from Trillion-X/trillion `src/tool-listing-budget.mjs`. |
| `read-data/tool-listing-budget.json` | The levels, their order, the request and meta field names and the words said. Moved byte for byte. |
| `read-data/tool-behavior-notes.mjs` | `withBehaviorNotes(tool, rules?)`: one sentence per matching hint row added after the description, never twice. Moved byte for byte from `src/tool-behavior-notes.mjs`. |
| `read-data/tool-behavior-notes.json` | The hint rows (`when`, `say`, `unless`). Moved byte for byte. |
| `read-data/tool-write-class.mjs` | `writeClassOf(tool)`: `'read'` or `'write'`, from `read_only` or the operation's leading verb. Moved byte for byte from `src/tool-write-class.mjs`. |
| `read-data/tool-write-class.json` | The read verbs. Moved byte for byte. |
| `read-data/tool-releases.mjs` | `compareVersions`, `compatibleRelease(row, hostVersion)`, `oldestNeeded`, `withEarlierReleases`. Moved from `src/tool-releases.mjs` with one change: the `../server.json` import and the `HOST_VERSION` export it fed are dropped, and `compatibleRelease` takes the host version as its argument with no default (the old Worker read its own version; here the caller says it). Everything else is byte for byte, the header comments included. |
| `read-data/tool-releases.json` | `keep_earlier`. Moved byte for byte. |
| `read-data/listing-tools.mjs` | The four rows' functions, each handing its input to one moved module. |
| `tool-rows.json` | `tool:fit-a-tool-list-in-a-budget`, `tool:say-a-tools-hints-in-its-description`, `tool:tell-if-a-tool-changes-anything`, `tool:pick-the-release-a-host-runs`; container rows run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/tool-listing-budget.test.mjs` | Trillion's `test/tool-listing-budget.test.mjs`, the test that needs no caller, assertions unchanged. |
| `test/tool-behavior-notes.test.mjs` | Trillion's `test/tool-behavior-notes.test.mjs`, its first three tests, assertions unchanged. |
| `test/tool-write-class.test.mjs` | The `writeClassOf` assertions from Trillion's `test/spaces.test.mjs`, unchanged. |
| `test/tool-release-compat.test.mjs` | Trillion's `test/tool-release-compat.test.mjs`, its two pure tests, assertions unchanged. |
| `test/listing-tools.test.mjs` | The four rows run as the container runs them. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `listWithinBudget` | `(tools, budget, rules?) => { tools, level, chars, fits } \| null` | The most detailed level whose whole list fits; the least when none fits; null without a positive budget. Never renames, reorders or drops a tool. |
| `withNamedInFull` | `(shown, full, names, rules?) => { tools, unknown, said? }` | Named tools put back in full in their place; names no tool has listed. |
| `withBehaviorNotes` | `(tool, rules?) => tool` | Rows are DATA, tried in order; a tool with no annotations is returned as it is. |
| `writeClassOf` | `({ id, read_only?, invoke?: { action? } }) => 'read' \| 'write'` | Derived, not declared; an operation not understood is a write. |
| `compatibleRelease` | `(row, hostVersion) => release \| null` | The row itself, else the first earlier release whose minimum the host meets, without its `earlier_releases`. |
| `oldestNeeded` | `(row) => version \| null` | The version to name when the host runs no release. |

## Moved from Trillion

Trillion-X/trillion `src/tool-listing-budget.mjs` (F-0158), `src/tool-behavior-notes.mjs` (F-0124), `src/tool-write-class.mjs` (F-0396; its rule `run_write_tool` in `src/space-permission-rules.json` stays in trillion) and `src/tool-releases.mjs` (F-0461), each with its JSON.

Tests left with their callers in trillion: `test/tool-listing-budget.test.mjs`'s first and third tests (they list through `src/tools.mjs` `handleMcpMessage`); `test/tool-behavior-notes.test.mjs`'s last test (the hosted tools list, `src/tools.mjs` and `src/mcp-tool-review.mjs`); the rest of `test/spaces.test.mjs`'s write-tool test (a pursuit's rules through `src/person-spaces.mjs`); `test/tool-release-compat.test.mjs`'s three tests that publish and run through `src/workshop.mjs`. The rows' test covers the listing levels and named tools over the moved code directly.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs` only; no door is opened), Node's standard library.

**Depended on by:** `tool-rows.json`. In Trillion-X/trillion these still import their own copies: `src/tools.mjs` (listing budget, behavior notes), `src/person-spaces.mjs` and `src/person-store.mjs` (write class), `src/workshop.mjs` (releases, with `HOST_VERSION` from `server.json`).
