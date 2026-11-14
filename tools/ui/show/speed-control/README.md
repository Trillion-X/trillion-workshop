# speed-control

One control for how fast a voice or a sound plays, from very slow to very fast, and the one speed scale every voice and player reads.

## Files

| File | Purpose |
|------|---------|
| `SpeedControl.tsx` | The control: the shared Slider on a log scale (fine steps everywhere between `min` and `max`) with the speed written as its value, and every preset step as a one-press Button. |
| `speeds.json` | DATA: the one speed scale (`min`, `max`, `step`, `default`, `presets`). Read by this control, the shared AudioClipPlayer's speed menu, and `src/voices.mjs` (the speed every voice and place Trillion speaks resolves within). |
| `index.ts` | Exports the control, the scale and its helpers. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `SpeedControl` | `({ label, value: number \| null, onSpeed(speed), description?, scale? }) => JSX` | Sets a speed; the caller keeps it (a list row, a player). `null` shows the scale's default. |
| `SpeedScale` | `{ min, max, step, default, presets }` | A scale; `speedScale` is the shared one from `speeds.json`. |
| `speedOnScale` | `(speed, scale?) => number` | Rounds to `step` and keeps inside `min`..`max`. |
| `speedLabel` | `(speed) => string` | "0.8×", "12×". |

## Dependencies

**Depends on:** `parts/ui` Slider, Button, Container, Text.

**Depended on by:** `parts/ui/show/audio-clip-player` (its speed menu steps), `parts/ambience/show/voices-panel.tsx` (each voice's and place's speed), `src/voices.mjs` (the scale every speed resolves within).

## Invariants

1. The scale is DATA; no speed is named in code.
2. The caller owns the value and where it is kept.
3. A speed is times natural with the pitch kept; players clamp to what they can reach.
