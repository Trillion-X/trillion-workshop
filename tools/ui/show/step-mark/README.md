# step-mark

The mark beside one step whose state is proven elsewhere: its number while still to do, the round success tick the shared steps checklist draws once done, a dashed ring while its state could not be read, and a calm pulsing empty ring while its state is not known yet (`checking`, a `done: null` step, never drawn as not done). Every list of steps uses it, so no screen draws its own circle, tick or colour.

## Files

| File | Purpose |
|---|---|
| `StepMark.tsx` | The read-only mark (`StepMark`) and `stepMarkState`, which turns a proven `done` into a state. |
| `index.ts` | The public entry (declared in `ui/part.json`). |

## Key types

| Type | Shape | Role |
|---|---|---|
| `StepMarkProps` | `{ state: StepMarkState, n?: number, className? }` | The state to show and the step's number; a `todo` step with no number is an empty ring (waiting). |
| `StepMarkState` | `'done' \| 'todo' \| 'unknown' \| 'checking'` | Proven done, still to do, not readable, or not known yet (checking draws no number and no tick). |
| `stepMarkState` | `(done: boolean \| null \| undefined, nullIsUnknown = false) => StepMarkState` | A step's `done` as a state. |

## Dependencies

**Depends on:** React only; look in `screen-look/show/step-mark.css`.

**Depended on by:** the shared guide's steps (`ui/show/coss/guide.tsx`), which draw Get started (the setup gate) and every guide screen's numbered steps, and `step-pill`.

## Invariants

1. Read-only: it shows a state and is never a control; a step the person ticks is `steps-checklist`.
2. No product words: the number and anything a screen reader hears are the caller's.
3. The done fill is the look's success colour, the same as the steps checklist's tick, never ink or the accent. `parts/screen-look/one-look-rules.json` rule `step-mark-from-the-shared-part` refuses a step mark drawn anywhere else.
