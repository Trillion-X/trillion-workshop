# still-working

A long wait says it is still working, in words that change as time passes, and says when it was asked again, so a 30 second wait never looks frozen and a silent retry is never silent.

## Files

| File | Purpose |
|------|---------|
| `still-working.ts` | The words for a wait at a given age and number of tries, the page's chosen words, and the window event a road sends when it asks again. No React. |
| `use-still-working.ts` | `useStillWorking(running, label)`: the words to say now, read again every second and on every asking again. |
| `index.ts` | The part's exports. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `StillWorkingStep` | `{ after_seconds: number; words: string }` | One step: said once `after_seconds` have passed; words fill `{label}`, `{seconds}`, `{tries}`. |
| `StillWorkingWords` | `{ steps: StillWorkingStep[]; again: string }` | The owner's words: the steps, and what is said once the wait was asked again. |
| `chooseStillWorkingWords` | `(words: StillWorkingWords \| null) => void` | The owner chooses the words once as the page starts; with none, nothing extra is said. |
| `stillWorkingAt` | `(label, seconds, tries, words?) => string \| null` | What a wait says now, or null while its own words stand. |
| `sayAskedAgain` / `onAskedAgain` | `({ path?, attempt }) => void` / `(listen) => stop` | A road that sends a busy answer again says so; every running wait counts it. |
| `ASKED_AGAIN_EVENT` | `'trillion:asked-again'` | The window event. |
| `useStillWorking` | `(running: boolean, label: string) => string \| null` | The React hook the pressed button and the loading rows use. |

## Dependencies

**Depends on:** React (`use-still-working.ts` only).

**Depended on by:** `parts/ui/show/button/press-work.tsx` (a pressed button's pending face), `parts/ui/show/screen-state/ScreenState.tsx` (a screen's loading rows), `parts/ui/show/server-rendered-page/page-work.mjs` (a server page's pressed action); the owner's words come from `src/home-words.json` `still_working` (chosen in `src/workspace/main.tsx`) and `src/sign-in-methods.json` `still_working` (chosen in `src/client/passkey.mjs`); `src/workspace/api.ts` says when it asks a busy read again.
