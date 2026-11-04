# Account Session Work

Browser-side helpers for the account session: which browser this is, and which
signed-in account (if any) belongs to it.

The Bitfield-era package also held returning-login, transient-session and
verified-session writers (`start-returning-login`, `authorize-transient-session-target`,
`start-verified-browser-session`); this Trillion copy ships only the browser
helpers below. Sign-in itself belongs to the Trillion service.

| File | Purpose |
|---|---|
| `README.md` | Explains the account-session work helpers. |
| `browser-session-browser-id.ts` | Reads, or creates once, this browser's own id in local storage. |
| `read-current-browser-session.ts` | Reads the signed-in account for this browser with no argument; shares concurrent reads and returns an unchanged session as the same object. |

| Type | Signature / Shape | Role |
|---|---|---|
| `currentLogBrowserSessionBrowserId` | `() => string` | This browser's id (`browser:<uuid>`), kept in local storage. |
| `readAccountPortalBrowserSession` | `(onError?: (error: unknown) => void) => Promise<CurrentBrowserSession>` | The active session for this browser (`{accountId, accountIdHash, email, emailConfirmed, status:'signed_in', authority, ...}`) or `null`; failures resolve to `null` and go to `onError`. |
| `CurrentBrowserSession` | `Awaited<ReturnType<typeof readAccountPortalSession>>` | The session shape `read-data/read-browser-session.ts` decodes. |

**Depends on:** `../read-data/read-browser-session` (`readAccountPortalSession`), which reads through `#workspace-records`.

**Depended on by:** `parts/screen-arrangement/show/screen-arrangement-context.tsx` (browser id); account screens that tie a saved profile to the signed-in account (the Mac app's Account screen, `mountAccountProfile` caller).
