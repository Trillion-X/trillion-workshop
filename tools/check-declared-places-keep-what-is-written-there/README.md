# tools/check-declared-places-keep-what-is-written-there/

Several places are declared writable on the promise that something keeps what is written there (a version history, a backup). This reports which of them keep nothing. Which places, where they are declared, what counts as keeping, and which are exempt and why are all DATA the person gives. Ported from the package `check-declared-places-keep-what-is-written-there`; the engine is unchanged.

## Files

| File | Purpose |
|------|---------|
| `do-work/check-declared-places-keep-what-is-written-there.mjs` | The engine: pure functions over a declaration and injected readers. It touches no disk. A place is found by KEY at any depth, so it never learns another owner's layout. Copied unchanged. |
| `do-work/check-my-places.mjs` | `tool:check-declared-places-keep-what-is-written-there`: the granted folder in argv, the input on standard input, `{ result }` on the last line. The disk half and nothing else. The granted folder is the home the places resolve against and the bound of the ancestor walk (the package used the person's home folder). Reading zero places, or a declaration that is not there, is a refusal and never a pass. |
| `part.json` | The engine is public, so another tool may import it. |
| `tool-rows.json` | The row. It runs on the person's computer after they grant `read-a-folder`. |
| `test/a-declared-place-that-keeps-nothing.test.mjs` | The package's test: key at any depth, every refusal, deduped bases, a marker at an ancestor, a second retention kind, exemption with its reason, unresolved not being a finding, a clean corpus versus an emptied input, and the same engine run against shipping bays. |
| `test/check-my-places-row.test.mjs` | The row's shape, and the command run the way the engine runs it over a made-up folder. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `placesIn` | `(declaration, { placesKey, idKey }) -> { id, declared }[]` | Every declared place, found by key at any depth; a key matching nothing returns `[]` so the caller can refuse rather than pass. |
| `resolvedPlaces` | `(places, { bases, home, join, isDirectory }) -> places with directories` | A place identifier onto real directories, deduped, relative to a run-time home. |
| `retentionAt` | `(directory, { kinds, marker, ancestorsOf }) -> string[]` | Which kinds hold at the directory or any ancestor; the walk is bounded by the caller. |
| `retentionReport` | `(places, { kinds, marker, ancestorsOf, exemptions }) -> Report` | The whole answer, never a boolean, with the number examined beside the number that keep nothing. |

## Dependencies

**Depends on:** nothing (Node 24 in the engine's run).

**Depended on by:** `tool-rows.json`. The local engine runs the row on the person's computer (`computer` kind) after the person grants `read-a-folder`.
