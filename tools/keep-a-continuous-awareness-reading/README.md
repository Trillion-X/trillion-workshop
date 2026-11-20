# tools/keep-a-continuous-awareness-reading/

The pure parts of the Awareness reading: what a reading sees becomes pursuits, the picture a model reply is kept as, and
the sections a guided screen draws from the kept picture. Ported from `src/awareness.mjs` of the old repository
(commit b6ae0ebf8), the owner its move-row names (`keep-a-continuous-awareness-reading`, tools/move-code-between-trees).

Every stage, trait, judgement, choice, limit and word is content the caller hands in as `settings` (the awareness rows).
Nothing here imports `src/awareness.json`; the map's words and areas are handed in the same way.

## Files

| File | Purpose | Old source (b6ae0ebf8) |
|---|---|---|
| `src/found-pursuits.mjs` | `foundPursuits`: the pursuits a reading adds, the areas it adds to recorded ones, and the ends of pursuits it found earlier | `src/awareness.mjs:285-322` |
| `src/picture.mjs` | `awarenessPrompt`, `mergePicture`, `reviewTraitHistory`, `shapePicture`, and the shared `text` / `list` / `fill` / `aboutIds` helpers | `src/awareness.mjs:84-124` (prompt, helpers), `131-236`, `239` |
| `src/awareness-sections.mjs` | `awarenessSections`: the computed state-to-sections shape (heading, banner, catalogs, questions waiting, right-now row, pursuits, observations) | `src/awareness.mjs:656-766` |
| `test/made-up-settings.mjs` | Made-up awareness and map content for the tests (not a test file) | none |
| `test/found-pursuits.test.mjs`, `test/picture.test.mjs`, `test/awareness-sections.test.mjs` | `node --test` suites | none |

## Handed in, not read here

- `keepAreas(ids, areas)`: keeps only the ids of the person's map. It is the map owner's function now
  (`workflow:place-pursuits-on-a-life-map`, `tools/workflows/recipes/place-pursuits-on-a-life-map.json`, which replaced
  `src/life-map.mjs`). `shapePicture` refuses `areas` without it.
- `mapSections` and the read-now action (`readNow`) are presentation the screen owner builds; `awarenessSections` places
  `mapSections` after the pursuits.
- `mapWords` (the map's `pursuit_areas` label) is needed only when the state carries a map.

## Not here (left, with the reason)

- The reader loop (`awarenessReader`, `src/awareness.mjs:360-500`) needs `keptAreas`, `mapForReading` and `placeOnMap`
  from the map owner's code, which no longer exists as code on origin/main. It waits for a map adapter.
- `awarenessInputs` (`:537-645`) and `awarenessQuestions` (`:248-282`) read the store through the engine's `sql`,
  `eeaf` and `lists()` APIs, which origin/main does not provide as code.
- `askChosenAwarenessModel` (`:64-82`) imports `refusedWork` from the retired `src/own-ais-routing.mjs`.
- `replyObject` (`:516-524`) is the same function as `tools/keep-a-persons-pursuits-tidy-by-merging-duplicates/src/pursuit-consolidate.mjs:75`
  (its error text differs and it has no NotJson class). Not copied here; see the report.

## Running

`node --test tools/keep-a-continuous-awareness-reading/test/*.test.mjs` from the Workshop root (the fixture is not a test).
