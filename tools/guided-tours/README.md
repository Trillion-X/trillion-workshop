# tools/guided-tours/

Guided tours, walkthroughs, spotlights and branching quizzes over any app's screens: the Workshop tools `tool:step-through-a-guided-tour`, `tool:check-if-a-tour-step-may-advance`, `tool:find-the-tour-an-event-starts` and `tool:find-the-event-that-starts-one-tour`, run in the tool container. Ported from the guided-overlay package: its engine (cursor and branch routing, advance conditions, trigger intake) and its tour-record fold, as plain data in and data out.

A first-run tour, a feature spotlight, a replay and a quiz that routes by answer are all the same thing: an ordered or branching list of steps, a cursor, and a trigger that starts it. The tools read only what they must (a step's id and branch_map, a trigger's event and suppression key, a condition's op and args). What a step shows, where it points, how it is placed and what a trigger's reason means pass through untouched, as the tour author wrote them.

## Files

| File | Purpose |
|------|---------|
| `do-work/tour.mjs` | The mechanism, pure: `resolveBranch`, `startTour`, `advance`, `retreat`, `jump`, `restart`, `canAdvance` and `createAdvanceOps`, `selectTrigger`, `startEventForTour`, `foldTours`, `selectTourForEvent`. |
| `do-work/tours.mjs` | The command of all four tools: the verb (`step`, `may-advance`, `find`, `start-event`) is the first argument, one JSON request is on standard input, `{ result }` or `{ error }` is the last line. |
| `tool-rows.json` | The four tool rows. |
| `part.json` | The pure module other tools may import. |
| `test/tour.test.mjs` | The package's engine and record-fold tests, over made-up bakery tours. |
| `test/tours-command.test.mjs` | The four commands run as the container runs them. |

## Key Types / Functions

| Function | Signature | Role |
|---|---|---|
| `advance` | `(tour, cursor, answer?) => cursor` | Routes by the step's branch map, else to the next step; the end completes and the cursor stays on the last step. |
| `canAdvance` | `(condition, signals, ops?) => boolean` | Evaluates `{ op, args }`; `all-of` and `any-of` recurse; an op nobody defined is false. |
| `selectTrigger` | `(triggers, event, consumedKeys) => trigger \| null` | First trigger in the order written that matches the event and whose key is not used up; its key is scoped by the event fields it names. |
| `foldTours` | `(records) => { [id]: tour }` | Records oldest first; a later one replaces, a deleted one removes; sorted by id. |

## Invariants

- Nothing is remembered between calls. The caller keeps the cursor and the used-up suppression keys, in its own records.
- No tour, step, reason or op is named here: tours are the person's own records.
- An unknown advance op holds the step; it never pushes a person on.

## Not here

The overlay itself (spotlight, scrim, step cards, placement and target finding on screen, the progress dots) belongs to the screens. The writers that saved a run's progress and outcome to the old log, and the bridge that fed live signals from other packages, were old-engine plumbing; a caller stores the cursor and the keys as ordinary records.

## Dependencies

**Depends on:** Node 24 in the tool container (`node:stream/consumers`).

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
