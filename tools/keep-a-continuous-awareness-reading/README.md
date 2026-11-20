# tools/keep-a-continuous-awareness-reading/

The continuous reading of a person: what comes in (their messages, the results of their files and recordings, what their
AIs did) is read as it arrives, and one picture of them is kept: their pursuits and where they head, their traits, whether
each pursuit is worthwhile, the stages each thing found goes through, whether what they are doing now is on their path, and
the questions the inputs cannot answer.

Ported from `src/awareness.mjs` of the old repository (commit b6ae0ebf8), the owner its move row names
(`keep-a-continuous-awareness-reading`). Every stage, trait, judgement, choice, limit and word is content the caller hands in
as `settings` (the awareness rows). Nothing here imports `src/awareness.json`.

## Files

| File | Purpose | Old source (b6ae0ebf8) |
|------|---------|------------------------|
| `src/reader.mjs` | `awarenessReader`: `nextDue`, `runDue` (one reading, or its wait), `read` (the picture, the reading state, the map). Every store is injected. | `src/awareness.mjs:360-500` |
| `src/inputs.mjs` | `awarenessInputs`: `unread`, `read`. Plain SQL over `messages`, `namespace_results` and the `activity` view, a bounded page at a time, cursor kept. `resultsQuery` and `messagesQuery` build the statements. | `src/awareness.mjs:537-645` |
| `src/questions.mjs` | `awarenessQuestions`: `asked`, `waiting`, `keep`. Plain SQL over the reading's own table `awareness_questions` (created on first use). | `src/awareness.mjs:248-282` |
| `src/ask-model.mjs` | `askAwarenessModel`: the reader's one question to a model, asked through the routing owner's `modelCalls(...).answered`. | `src/awareness.mjs:64-82` (replaced, see below) |
| `src/record-found.mjs` | `keepFound`: records each found pursuit on its own, counting refusals. | `src/awareness.mjs:326-334` |
| `src/reply.mjs` | `replyObject`, `replyText`, `NotJson`: the JSON object in a model's reply. | `src/awareness.mjs:516-524` (`replyObject`) and the reply helpers just above it |
| `src/picture.mjs` | `awarenessPrompt`, `mergePicture`, `reviewTraitHistory`, `shapePicture`, the shared `text` / `list` / `fill` / `aboutIds` helpers. | `src/awareness.mjs:84-124`, `131-236`, `239` |
| `src/found-pursuits.mjs` | `foundPursuits`: the pursuits a reading adds, the areas it adds to recorded ones, the ends of pursuits it found earlier. | `src/awareness.mjs:285-322` |
| `src/awareness-sections.mjs` | `awarenessSections`: the computed state-to-sections shape for Progress. | `src/awareness.mjs:656-766` |
| `do-work/read-awareness.mjs` | `readAwareness`: the tool's container function (action `read` or `next_due`) over the state the caller hands in. | none (new) |
| `tool-rows.json` | The Workshop row `tool:keep-a-continuous-awareness-reading` with its container invoke and package-files keys for `src`, `do-work` and the map's `src`. | none (new) |

## Placement and map

`reader.mjs` imports `keptAreas`, `mapForReading` and `placeOnMap` from `tools/place-pursuits-on-a-life-map/src/life-map.mjs`.
The map's rows are read by the caller's own SQL and handed in (`map.areas()`); the module runs no SQL.

## Changed from the old code (on purpose)

- `askChosenAwarenessModel` (old `:64-82`) picked the person's connected providers and rethrew `refusedWork` from the retired
  `src/own-ais-routing.mjs`. The routing owner now is `tools/keep-and-wake-ai-sessions-on-this-computer/src/model-calls.mjs`
  (`modelCalls(...).answered`, the one road every model call takes; the person's routes are `tools/route-model-calls/src/model-routes.json`).
  A call no route answers throws `NoChosenAI` (`no_chosen_ai: true`), which the reader turns into a wait.
- Questions were rows of a person's list through `lists()`. They are now rows of this owner's table `awareness_questions`.
  Answering them in the list's views is lost until the list wiring is rebuilt (see the lane report).
- The old engine's `sql`, `eeaf`, `fields` and `namespace-results` calls are plain SQL. `namespace_results` takes its position as
  a row value `(recorded_at, identity, kind)`, because the old table's `rowid` does not exist on the person's Postgres store.
- `startMap` (the map's list creation) is not here: writing the map is the map owner's job.

## Not here

- The reading's scheduler (who calls `runDue` and with which store adapters) is the engine's. This folder ships the readers.
- `awarenessTools` and `awarenessAnnotations` (old `:769-779`) are not ported: their owner is the held registry file of the
  tool-listing owner (named in the lane report).
- The messages table the inputs read (`messages`) is assumed, not verified: a read-only check of the person's store found
  no table whose name contains "message" outside its old schema. The message source needs its owner's table name before a
  reading runs against a real store.

## Running

From the Workshop root, with a glob (a directory argument fails on node 25):

    node --disable-warning=ExperimentalWarning --test tools/keep-a-continuous-awareness-reading/test/*.test.mjs

The SQL tests use `node:sqlite` (experimental in node 25; the flag only silences its banner). `test/sql-store.mjs` and
`test/made-up-settings.mjs` are fixtures, not tests.
