# page-storage

The one way a page reaches the storage kept on this device (localStorage), answering null where the page may not use any (inside another app's frame, with site storage blocked, on a blank page) instead of throwing.

## Files

| File | Purpose |
|------|---------|
| `page-storage.ts` | `pageStorage()`: the page's storage, or null where there is none or it is refused. `keptAccount()`: the account this page is kept for, read from the `kept-answers` script element, or null. `accountKey(key)`: the storage key scoped to that account, or null when no account is signed in. Never throws. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `pageStorage` | `() => Storage \| null` | The device's storage for this page, or null; a caller keeps nothing past the page when it is null. |
| `keptAccount` | `() => { store: string; key: string } \| null` | The signed-in account this page belongs to, or null when nothing is kept. |
| `accountKey` | `(key: string) => string \| null` | `${key}@${store}` for the signed-in account, or null. A caller with null writes nothing. |

## Rule

Anything kept on the device for a person is kept under `accountKey(...)`, never under a bare key. Account B on the same browser never reads account A's kept items, and A finds its own again when it returns. A caller with no signed-in account keeps nothing. A bare key left by an older build is removed where it is found, never read as anyone's.

## Dependencies

**Depends on:** nothing.

**Depended on by:** `src/workspace/api.ts` (`deviceAccount()`), `parts/ui/show/selection/tray-store.ts` (the tray kept across reloads), `parts/ui/show/recent-steps/recent-steps.ts` (steps before an ask), `parts/ui/show/asked-now/use-asked-now.ts` (an ask acted on once), `src/workspace/share-outbox.ts` (shares waiting to be sent), `src/workspace/always-recording-screen.tsx` (the always-recording state kept on this device).

## Why

Reading `localStorage` throws where a page may not use storage. The tray store read it while its module loaded, so from 820ba359 every screen importing the tray (Decisions, Lists) drew nothing on such a page. Each caller had its own copy of the guard, and the tray store had none; this is the one copy.
