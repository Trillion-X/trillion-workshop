# happened

The one channel a screen uses to say that something happened for the person; any listener (parts/delight-moments with words, parts/feel with touch, sound and motion) answers it, and the sayer never knows who listens.

| File | Purpose |
|---|---|
| `happened.ts` | `sayHappened` and `onHappened` over one window event. |
| `observe-handling.ts` | `observeHandling(root)`: one delegated listener each that says `chosen` (a menu row, option, radio, tab or switch picked), `lifted` (a drag starts) and `dropped` (a drop the page took), with the element as `target`. |

## Key functions

| Function | Signature | Role |
|---|---|---|
| `HAPPENED_EVENT` | `'trillion:happened'` | The window event name. |
| `sayHappened` | `(detail: { event_kind: string, ...fields }) → void` | Fire and forget. |
| `onHappened` | `(listen) → stop` | Listen to every happened event. |
| `observeHandling` | `(root?) → stop` | Say what the person's hands did anywhere under `root`. |

## Dependencies

**Depends on:** nothing.

**Depended on by:** `guided-overlay` WalkthroughHost (`tour-finished`), `ui` action-feedback `runCommand` (`work-done`, `work-failed`), `ui` button press-work (`press-done`, `press-failed`), `ui` composer (`message-sent`, `message-failed`), `ui` notification center (`notice-arrived`), `ui` SortableRows (`lifted`, `dropped`), the Home screen (`needle-found`), `delight-moments`, `feel`.
