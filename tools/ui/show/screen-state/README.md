# Screen State

The one way a screen says where its read stands: still loading, answered with nothing, partly unavailable, or refused.

| File | Purpose |
|---|---|
| `ScreenState.tsx` | Draws loading rows, empty, unavailable and failed states; runs a read through them (`loadScreen`, `useScreenLoad`). |
| `index.ts` | Public barrel. |

| Name | Signature / Shape | Role |
|---|---|---|
| `ScreenStateValue` | `{status:'loading', label, layout?} \| {status:'empty', title, description?, icon?, action?, secondary?} \| {status:'unavailable', title, description?, icon?, retry?, inline?} \| {status:'failed', title, description?, kept?, icon?, retry, secondary?, inline?}` | The state to draw. Unavailable and failed states can be inline when useful results remain visible. A failed state's `kept` says what the failure left as it was, only when that is known. |
| `ScreenState` | `({state}) => JSX` | Draws one state. |
| `mountScreenState` / `releaseScreenState` | `(host, state) => void` / `(host) => void` | Draw into an element / let it go. |
| `loadScreen` | `(host, ScreenLoad<T>) => LoadedScreen` | Imperative lifecycle: loading, then failed / empty / draw, with reload and dispose. |
| `useScreenLoad` | `(key, load) => ScreenRead<T>` | The same lifecycle for React screens. |

A read the loader starts may answer at once from a copy kept on this computer (`../request/kept-answers.ts`): the loader draws it and reads again when the network's answer differs. An imperative screen with an `update(value)` callback receives later answers in place, preserving its local edit state and focus. Without that callback, a changed kept answer still clears and draws anew. Empty/refused states and disposal still release the drawing.

**Depends on:** `../request/kept-answers` (`readWithKeptAnswers`, `keptAnswersServed`, `onKeptAnswerReplaced`), `../shadcn/empty`, `../shadcn/skeleton`, `../loading-mark`, `../still-working` (a long load says it is still working and that it was asked again), `../coss/ui/button`, `../icon/NamedIcon`, `../coss/workspace-controls` (`mountSharedContent`), `../coss/notifications`, `../one-owner-per-node`; looks in `parts/screen-look/show/screen-state.css`, `media-loading.css`, `loading-mark.css`.

**Depended on by:** every workspace screen (`src/workspace/*`, enforced by `test/every-screen-has-its-states.test.mjs`); `coss/workspace-controls.tsx` `mountEmpty`/`mountMediaLoading`, which the Mac app calls.
