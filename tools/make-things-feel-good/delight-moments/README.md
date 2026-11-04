# delight-moments

Small good moments: when something good happens (a tour finished, work done) or a phrase is typed, the matching row in `records/delight-moments.json` plays one line of words with a motion, never a sound. What covers the workspace while it opens is the thread cover (`parts/ui/show/thread-cover`), drawn by the page's first bytes.

| File | Purpose |
|---|---|
| `read-data/choose-moment.mjs` | Pure pick: which row answers an event or a typed phrase, once-only and count rules, rotating words, and the memory to keep. |
| `show/mount-delight-moments.tsx` | Mounted once at the app shell (`src/workspace/main.tsx`): listens on the happened channel and to typing, queues and plays moments through `ui` `DelightMomentLayer`. |
| `part.json` | Which files other parts may import. |

## Key functions

| Function | Signature | Role |
|---|---|---|
| `chooseMoment` | `(rows, event, memory) → { moment, remember }` | The moment for one happened event. |
| `typedMoment` | `(rows, typedText, memory) → { moment, remember }` | The moment for a phrase typed anywhere. |
| `longestTypedPhrase` | `(rows) → number` | How many typed characters the player keeps. |
| `answeredKinds` | `(rows) → Set<string>` | Event kinds some row answers (used by `scripts/check-delight.mjs`). |
| `chooseWaitingScene` | `({ rows, ownScenes, looks, memory, hidden, random }) → { scene: { id, look, words } \| null, remember }` | The scene for one wait. |
| `startWaitingMoment` | `(host, account, fallback) → { progress(ready, total), done() }` | Plays a wait's scene. |
| `rememberWaitingChoices` | `(account, showOf, readList) → Promise<void>` | Keeps what the next wait needs on this device. |
| `mountDelightMoments` | `({ el, props: { rows } }) → unmount` | The player. |

## Dependencies

**Depends on:** `ui` (`show/happened/happened.ts`, `show/delight-moment/DelightMoment.tsx`, `mountReactSurface`), `framer-motion` through `ui`.

**Depended on by:** `src/workspace/main.tsx`; `scripts/check-delight.mjs` refuses a push that says an event no row answers (unless listed in `quiet_events`).
