# ui/show/capture-control

The one full-bleed "press to start / press to stop" capture button: one giant circular control whose face follows a single `state` prop (idle, recording, working), with an elapsed-time pill while recording.

## Files

| File | Purpose |
|------|---------|
| `CaptureControl.tsx` | The control and `formatElapsed(ms)` (mm:ss). Purely presentational: it owns no microphone, recorder or upload. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CaptureControl` | `({ state, elapsedMs?, readElapsedMs?, ticking?, onStart?, onStop?, disabled?, startLabel?, stopLabel?, workingLabel?, className? })` | Draws the one button for the current state; the caller holds the capture and passes state down and presses up. With `readElapsedMs` the time is read from the capture itself and redrawn by the time alone (every 250 ms while `ticking`, and on every scroll or return to the page), so the screen around it never re-renders to move it. |
| `CaptureControlState` | `'idle' \| 'recording' \| 'working'` | Closed by what a capture is: not started, running, being finished. |
| `formatElapsed` | `(elapsedMs?: number) => string` | Elapsed time as mm:ss, clamped at 0. |

## Rules

- Verbs and the working line are props; the caller supplies its own words (Trillion's Record screen passes Record, Done and "Saving your recording…").
- Colour comes from the shared Button, Badge and Text variants; `className` is layout only.
- The working face draws the shared `Spinner` (the one loading mark), never its own.
- The time shown is always derived from the capture (its start and paused spans, `readElapsedMs`), never counted up by a timer, so a timer the browser slows or skips (a scroll, a hidden tab) can only delay a redraw, never make the time wrong.

## Dependencies

**Depends on:** `../badge`, `../button`, `../container`, `../icon`, `../spinner`, `../text`, `../cn`, `lucide-react`.
**Depended on by:** `src/workspace/record-screen.tsx` (through the `parts/ui` barrel).
