# action-feedback

The one place a command a person gives says what happened and is written down: a server command announces its outcome once as a toast that stays in the notification center's history, a screen-only command (a pane resized, a menu entry chosen) is written to history quietly, and every command reaches the app's durable action history.

## Files

| File | Purpose |
|------|---------|
| `action-feedback.ts` | The sink, the delegated press listener, and the server-command runner. |
| `index.ts` | Public exports. |
| `action-feedback.test.ts` | Announce-once, page-spoke-first silence, failure stays, quiet choices, pane commands, delegated presses. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `provideActionFeedback` | `(sink: {center, record?, settleMs?} \| null) => restore` | Install where commands are announced and recorded. Without a sink nothing is shown. |
| `observeChoices` | `(root = document) => stop` | One capture click listener for every button and menu entry under `root`; skips disabled controls, menu triggers, disclosures and `[data-feedback=none]`. |
| `reportChoice` | `(label, surface?) => void` | A chosen control; quiet history entry unless a server command starts within the settle window. |
| `reportScreenCommand` | `(label, surface?) => void` | A screen-only command that is not a press (pane resized by dragging). |
| `runCommand` | `(label \| null, run) => Promise<T>` | Run one server command; announce done or failed once, silent if the page already announced it. A failure stays until handled. |
| `CommandRecord` | `{label, surface?, outcome: 'done' \| 'failed', detail?}` | What `record` receives. |

## Dependencies

**Depends on:** `../notifications/notification-center` (the center the sink holds).
**Depended on by:** `action-menu/ActionMenu.tsx` (keyboard-shortcut choices), `screen-arrangement/show/SplitTreeArranger.tsx` (pane resize), the Expansion page (`media-workspace.js` through `shared-controls-entry.ts`).

## Invariants

1. Presses are heard once, by `observeChoices`; controls never report their own presses.
2. Scrolling, hovering and focusing are never commands.
3. A command whose own work already announced itself gets no second toast.
