# Toast (React hook shape)

`useToastContext()` and `ToastProvider` for React surfaces, answered by the one shared notification center in `../notifications`. There is no separate toast state here.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | `useToastContext`, `ToastProvider`, `UseToastReturn`; every call emits into the shared center. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `useToastContext` | `() => UseToastReturn` | `{toasts, addToast, showError, showSuccess, showWarning, showInfo, dismissToast, clearAll}` over the shared center. `toasts` are the visible records. |
| `ToastProvider` | `({children, position?}) => ReactElement` | Ensures the shared stack and bell are mounted; the first mounter's position wins. Nesting it is harmless. |
| `UseToastReturn` | interface | The hook's return shape. |

## Dependencies

**Depends on:** `../coss/notifications` (`ensureNotificationHost`, `notificationCenter`), `../notifications/notification-center` (types), `../coss/ui/toast` (`ToastPosition`).

**Depended on by:** service-connections, visual-database, documents, screen-look, sales-contract-builder, learning-home, access-scoped-content, ask-questions-sort-answers-follow-up, record-audio; re-exported from `packages/ui/index.ts`.

## Invariants

- One stack per document; this module never renders its own toasts.
- The old reducer, `ToastItem` and `ToastContainer` were removed when the shared center replaced them; use `notify` from `../coss/notifications` for anything beyond these helpers (progress, actions, history).
