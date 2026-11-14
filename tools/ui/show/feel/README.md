# feel (players)

The device's players for a feel row (records/feel-moments.json, chosen by parts/feel): touch, sound and motion, and the feel log a proof reads.

| File | Purpose |
|---|---|
| `switch-tick.ts` | `switchTick()`: Safari on iPhone and iPad has no vibrate; inside a real tap it clicks a hidden switch's label (`<input type="checkbox" switch>`, iOS 18+), which plays the system's selection tick. One tick, no strength or timing. |
| `play-feel.ts` | `playFeel(plays, play)`: hands each output to its player in `FEEL_OUTPUT_PLAYERS`; touch tries `TOUCH_ROUTES` in order (an Apple app hosting the page over `webkit.messageHandlers.trillionFeel`, any other hosting app through a `TrillionFeelHost.play(json)` object it adds to the page, such as an Android WebView's JavaScript interface, then `navigator.vibrate` on Android browsers, then `switch-tick.ts` on iPhone and iPad Safari inside a real tap); sound synthesises the row's tones with Web Audio after the first tap (`wakeFeelSound`); motion plays the row's keyframes on the target (its `reduced` keyframes when the device asks for less motion); every play is written to `feelLog()`. |

## Key functions

| Function | Signature | Role |
|---|---|---|
| `playFeel` | `(plays: [{ output, play }], { target?, moment?, feel? }) → FeelLogEntry` | Plays one feel's outputs. |
| `FEEL_OUTPUT_PLAYERS` | `Record<string, (spec, play) → string \| null>` | One player per output; a new output is one entry. |
| `TOUCH_ROUTES` | `[{ id, play(touch, play) → boolean }]` | The ways a device can play touch, first that can wins. |
| `FEEL_HOST_CHANNEL` | `'trillionFeel'` | The message channel a hosting app listens on. |
| `wakeFeelSound` | `(root) → stop` | On the first tap or key asks for the audio context at idle (never made inside the key, which it would stall for up to a second); later taps wake a sleeping context. |
| `switchTick` | `() → boolean` | One system tick in iPhone Safari inside a real tap; false anywhere else. |
| `feelLog` | `() → FeelLogEntry[]` | The page's last 50 feels (`globalThis.__trillionFeel`). |

## Dependencies

**Depends on:** nothing.

**Depended on by:** `parts/feel` (`show/mount-feel.ts`), the iPhone, Mac and watch player `ios/Shared/FeelPlayer.swift` used by the watch app (`ios/Watch/WatchFeel.swift`) and Mac app (`macos/App/TrillionWorkspace.swift`, `macos/App/MenuBarPanel.swift`) through `trillionFeel`.
