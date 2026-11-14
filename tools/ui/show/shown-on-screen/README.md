# shown-on-screen

Whether the person can see an element right now, and a watcher that says when that settles either way. Screens that act only once they are actually looked at (a tour starting, new things counted as seen) judge "shown" here, the same way.

## Files

| File | Purpose |
|------|---------|
| `shown-on-screen.ts` | The one "shown" predicate and the settle watcher. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `isShownOnScreen` | `(element: HTMLElement) => boolean` | In the page, has a size, not hidden, and the tab is showing. |
| `watchShownOnScreen` | `(element, onChange: (shown: boolean) => void, settleMs = 800) => () => void` | Says `true` once the element has stayed shown for `settleMs`, `false` when it stops; returns the stop call. |

## Dependencies

**Depends on:** the DOM (`ResizeObserver`, `checkVisibility`, `document.visibilityState`).

**Depended on by:** `parts/guided-overlay/show/walkthrough-events.ts` (a tour starts on a shown screen).

## Invariants

- One predicate for "shown".
- Shown settles only after `settleMs` shown; hidden is said at once.
- Without `ResizeObserver` the element counts as shown once and is not watched.
