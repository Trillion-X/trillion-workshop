# feel

How each thing that happens feels, on every device: when a screen says something happened (parts/ui `happened`: a button's work done or failed, a message sent, a notice arriving, a row chosen, something picked up or dropped, a tour finished, the needle mover found), the matching row in `records/feel-moments.json` names a feel, and each output of that feel (touch, sound, motion, any later one) plays through the device's own player unless the person's show rules (subject `feel`) quiet it or give the moment another feel.

| File | Purpose |
|---|---|
| `read-data/choose-feel.mjs` | Pure: which moment row answers an event, what each output plays after the show rules (`changed`, `showOf`), and the repeat gap so one moment never plays twice. |
| `show/mount-feel.ts` | The entry, started once per page (`src/workspace/main.tsx`): hears the happened channel, starts `observeHandling` (chosen, lifted, dropped) and wakes sound on the first tap; `tryFeel` plays one feel now. |
| `show/FeelSettings.tsx` | Feel, a section of Look (`src/account-screens.mjs` lookScreen, lent by `src/workspace/guide-screens.tsx`): Touch, Sound and Motion switches for everything, and per moment a play button, its feel and its outputs; every change is a show rule. |
| `part.json` | Which files other parts may import. |

## Key functions

| Function | Signature | Role |
|---|---|---|
| `momentFor` | `(data, event) → row \| null` | The first moment row that answers an event (delight-moments `rowAnswers`). |
| `feelOutputs` | `(data, momentRow, feelId, rules, eventKind) → [{ output, feel, play }]` | What each output plays after the rules. |
| `chooseFeel` | `(data, event, rules, { now, played }) → { moment, plays, remember }` | Everything that plays for one event, with the repeat gap. |
| `feltKinds` | `(data) → Set<string>` | Event kinds a feel row answers (used by `scripts/check-delight.mjs`). |
| `mountFeel` (default) | `({ props: { rows } }) → stop` | Starts the feel on a page. |
| `tryFeel` | `(rows, feelId, target, outputs?) → FeelLogEntry` | Plays one feel now (Feel settings). |
| `FeelSettings` | `({ rows }) → JSX` | The Feel section. |

## Adding

- A moment: one row in `records/feel-moments.json` `moments` (`on.event_kind`, optional `on.match` / `on.starts_with`, `feel`).
- A feel: one entry in `feels`, with any outputs it plays.
- An output: one row in `outputs` and one player in parts/ui `show/feel/play-feel.ts` `FEEL_OUTPUT_PLAYERS`.
- A device: an app hosting the page listens on `window.webkit.messageHandlers.trillionFeel` (iPhone app: Core Haptics; Mac app and menu bar panel: the trackpad), or a new entry in `TOUCH_ROUTES`.

## Dependencies

**Depends on:** `ui` (`show/happened/happened.ts`, `show/happened/observe-handling.ts`, `show/feel/play-feel.ts`, `show/show-rules/show-of.ts`, Button, Card, Container, Dropdown, Switch, Text), `delight-moments` (`read-data/choose-moment.mjs` `rowAnswers`), `records/feel-moments.json`, `src/workspace/show-rules.json` (subject `feel`, starting rule that keeps phone sounds quiet at night).

**Depended on by:** `src/workspace/main.tsx`, `src/workspace/guide-screens.tsx`, `scripts/check-delight.mjs`, `test/feel-moments.test.mjs`.
