# tools/keep-private-sites-out-of-capture/

The `read-data/capture-exclusion.mjs` entry forwards its exports to the same-directory `-core.mjs` implementation. The exact historical source was committed as inactive evidence in `8889fe2f` before those fresh core paths were introduced; the earlier adapted-file birth is not presented as a source-only copy. The original behavior tests still run through this public entry. Inactive `source-baselines/` files are not imported or mounted by the tool rows.

Keeps categories of places (banking and finance, health, social networks, shopping, adult content, entertainment) out of what a screen or browser capture reads. It says which categories are on, whether one address is in them, turns a category on or off for the person, and takes in more domains as a cursor diff, so coverage grows without a new release. It runs on the person's own computer as a `computer` row that asks for no capability: the person's choices and the diff state come in with the input and the changed one goes back out.

## Files

| File | Purpose |
|------|---------|
| `read-data/capture-exclusion.mjs` | `loadState`, `domainsIn`, `categoriesOn`, `domainsOf`, `excluded`, `applyDiff`, and `exclusion(input)`, the row's function. |
| `read-data/capture-exclusion.json` | The categories with their defaults, the seed of domains per category, the starting cursor and every word said. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:capture-exclusion`: a `computer` row with `capabilities: []`, run by `tools/workflows`'s `do-work/run-a-function.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/capture-exclusion.test.mjs` | The original Trillion tests (the person's choice over the default, subdomains and look-alikes, diffs at the cursor, tombstones over the seed, a domain added back). |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `excluded` | `(settings, state, prefs, address) => category \| null` | A host equal to a listed domain or ending in `.` and one is in its category; `evilbank.example` is not in `bank.example`'s. |
| `applyDiff` | `(settings, state, { from, to, add, remove }) => state` | Refused (409) unless `from` is the state's cursor; a removed domain stays removed over the seed until a diff adds it back. |
| `exclusion` | `({ action: 'list' \| 'check' \| 'set' \| 'diff', address?, category?, on?, diff?, prefs?, state? })` | The row's function. `set` answers the new `prefs`, `diff` the new `state`, for the caller to keep. |

## Moved from Trillion

`computer/capture-exclusion.mjs` and `computer/capture-exclusion.json` (deleted in Trillion-X/trillion dc79bb0a87), with their tests from `test/capture-categories.test.mjs`. The code is the same, except that the Mac app kept the person's choices and the diff state in two files under their home folder (`prefs_file`, `state_file`); here both are the caller's, given with the input and answered back, so the run writes nothing.

## Not yet

- Nothing. The row asks for no capability the engine does not list.
- No capture tool in this repository asks it yet; `tools/read-what-is-on-screen` keeps its own never-read lists in `read-data/rules.json`.

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-a-function.mjs`), Node's standard library.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`. Nothing imports this folder.
