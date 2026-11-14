# Request

What a surface keeps and signals about its reads on this computer: the last answer to each read, kept on disk so a screen opened again draws at once, and the signal that tells a screen drawn from a kept answer to read again when the network's answer differs.

| File | Purpose |
|---|---|
| `kept-values.ts` / `kept-values.json` | Keeps one JSON value per key in an IndexedDB store, sealed with AES-GCM when given a key; deletes whole stores by name. Each value carries the build's row `schema` and an optional `role` (a read naming another role, or a value of another schema, reads as nothing kept; the sweep drops other-schema values). Values idle, old or past `entries_most` are swept once per page (never one written `unsynced`). An open that waits longer than `open_timeout_ms` (a stuck tab holds the store) reads as nothing kept and is recorded in `keptValuesProblems()`. |
| `kept-answers.ts` | The signal between a read that answered from a kept copy and the loaders that drew it: which reads may use a kept copy, how many did, and when one was replaced. |
| `current-presentation-rows.mjs` | Keeps a mounted presentation's current document for immediate local feedback; refreshes on mount, focus, visibility and an existing host content-change signal. Failed refresh disables rows, later refreshes fence stale replies, and stop removes every listener. `clearBeforeRefresh` clears fact-like data before demand; `invalidate()` (also on the single subscription callback) immediately clears rows and cancels late replies during a sign-in change. It creates no timer or per-event network wait. |
| `quiet-retry.ts` / `quiet-retry.json` | A busy or unreached service is waited out quietly: `retryQuietly(attempt, statusOf, { failures, onTry })` asks again after each wait in the JSON (1, 2, 4, 8, 15, 30, 60 s, about two minutes), only for busy answers and unreached requests, then hands back the last failure for the plain message. Used by `src/workspace/api.ts` (busy answers) and the chat view's `screen_read` bridge (`src/workspace/screen-view.tsx`). |

| Name | Signature / Shape | Role |
|---|---|---|
| `createKeptValues` | `(name, { key? }) => { read<T>(key), write(key, value) }` | One store of kept values; `key` (32 bytes base64url) seals every value, and a value that does not open reads as nothing kept. |
| `forgetKeptValues` | `(drop: (name) => boolean) => Promise<void>` | Deletes every store whose name `drop` accepts (another account's, or all at sign-out). |
| `readWithKeptAnswers` | `(read) => Promise<T>` | Runs a loader's read with kept copies welcome for the reads it starts before its first wait. |
| `keptAnswersWelcome` | `() => boolean` | Whether a read starting now may answer from a kept copy. |
| `keptAnswerServed` / `keptAnswersServed` | `() => void` / `() => number` | Counted by a read that answered from a kept copy; read by a loader before and after its read. |
| `keptAnswerReplaced` / `onKeptAnswerReplaced` | `(path) => void` / `(listener: (path) => void) => stop` | Said when the network's answer at `path` differs from a kept copy that was answered; heard by loaders that drew one (the page's first reads read again only that address). |

## Invariants

- A kept copy is only ever answered to a read a loader started (`readWithKeptAnswers`), because only a loader reads again when the copy is replaced.
- The caller owns freshness and keys: the workspace keeps one store per signed-in account, named and keyed by the Worker for that sign-in (`src/workspace/api.ts`, `src/kept-answers.mjs`), so a copy kept for one account never opens for another, and sign-out deletes every store (`src/client/passkey.mjs`).

**Depends on:** browser IndexedDB and Web Crypto only.

**Depended on by:** `parts/ui/show/screen-state/ScreenState.tsx` (`loadScreen`, `useScreenLoad`), `src/workspace/api.ts` (`readJson`), `src/client/passkey.mjs` (sign-out deletion).
