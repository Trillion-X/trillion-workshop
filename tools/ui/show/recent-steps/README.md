# recent-steps

What a person did just before they asked for help, kept on their own device and sent with the request, so whoever helps (their own AI) sees the path that led to it without the person explaining.

## Files

| File | Purpose |
|------|---------|
| `recent-steps.ts` | Notes and reads steps: `watchSteps()` notes the page events `watch` names (a press, a field taking focus) and page changes; `noteStep(kind, label)` lets any surface note its own kind (a pick); `recentSteps()` reads them oldest first for a press to carry; `nameOfControl(element)` names a control by its label, own words or placeholder, never what was typed into it. |
| `RecentSteps.tsx` | Shows the steps a request carries, one row per step: the kind's icon and word, the control's name, how long ago; at most `shown` rows, the rest counted. |
| `recent-steps.json` | DATA: how far back (`keep.steps`, `keep.minutes`), which page events make which kind (`watch`), the kind a page change makes (`page_kind`), words and icon per kind (`kinds`, `other_kind`), the attribute that keeps a surface's own controls out (`ignore`), and the shown words. |
| `index.ts` | The part's public names. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `RecentStep` | `{ at: string; kind: string; label: string; where: string }` | One step: ISO time, open kind, the control's name, the page path. |
| `watchSteps` | `(doc?: Document) => void` | Start noting steps on a page (once). |
| `noteStep` | `(kind: string, label: string, where?: string, now?: number) => void` | Note one step; the same step twice within `same_step_within_ms` is kept once. |
| `recentSteps` | `(now?: number) => RecentStep[]` | The steps within `keep`, oldest first. |
| `nameOfControl` | `(element: Element) => string` | What a control is called on the page. |
| `RecentSteps` | `({ steps, now? }) => JSX` | The list a person sees before sending. |

## Invariants

1. What was typed is never kept: a step names a control, never its value.
2. Steps stay on the device until a request is sent; nothing is written to a store per step.
3. No kind is named in code: a new kind is a `kinds` row, a new page event a `watch` row.
4. Steps are kept for the signed-in account only (`accountKey` in `../page-storage/page-storage.ts`): another account on the same browser never sees or sends them, and with no account signed in nothing is kept. A bare key from an older build is removed, never read.

## Dependencies

**Depends on:** `../container`, `../text`, `../icon` (shared UI), `../page-storage` (the account-scoped device storage).

**Depended on by:** `src/workspace/main.tsx` (starts `watchSteps`), `src/workspace/queue-job.ts` (every press carries `recentSteps()`), `src/workspace/point-at-anything.tsx` (notes a pick, shows `RecentSteps` in the card); `src/queued-work.mjs` checks and keeps them against `src/queued-work.json` `steps`.
