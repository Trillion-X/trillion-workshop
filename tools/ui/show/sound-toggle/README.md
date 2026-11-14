# ui/show/sound-toggle/

Pure browser-local mute/unmute button paint.

| Path | Purpose |
|---|---|
| `SoundToggle.tsx` | Render a caller-controlled sound enabled/disabled button. |

Rules:

- No Web Audio API.
- No addressed reads.
- No Envelope invokes.
- No sound package imports.
- Caller owns the sound state, label policy, and side effect.
