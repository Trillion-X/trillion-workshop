# ui/show/asked-now/

Acting once on an "asked now" record: a value with `asked_at` that the person's AI writes through their store to ask the open page to do something at once (start a tour, open a layout).

## Files

| File | Purpose |
|------|---------|
| `use-asked-now.ts` | `useAskedNow(value, storageKey, act, ready?, freshMs?)`: calls `act` once for each new `asked_at`, never for one already acted on (kept in localStorage) or one already older than `freshMs` when the page first saw it; holds an ask while `ready` is false. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `useAskedNow` | `(value: unknown, storageKey: string, act: (asked) => void, ready = true, freshMs = 120000) => void` | Once per ask, per browser. |
| `AskedNow` | `{ asked_at?: unknown, ...fields }` | The record as written. |

## Dependencies

**Depends on:** React.

**Depended on by:** `parts/guided-overlay/show/WalkthroughHost.tsx` (a tour an AI asked to show now), `parts/screen-arrangement/show/open-asked-layout.tsx` (a layout an AI asked to open now).
