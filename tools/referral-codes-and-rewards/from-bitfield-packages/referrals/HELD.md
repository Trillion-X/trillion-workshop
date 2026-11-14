# tools/referral-codes-and-rewards/from-bitfield-packages/referrals/

The bitfield-packages referrals package at d926b7adb8ca24159ee64f47e7d9cae254f5b641, moved here unchanged under its package paths (the pure code-and-reward logic is already in this tool and is not repeated). `moved-from.json` names each file's source path and commit and its BLAKE3 identity. Nothing here is wired into `tool-rows.json`.

| Path | What it holds | Status |
|---|---|---|
| `show/app-shell/ReferralsPortalSurface.tsx.held`, `show/mount-referrals-portal.tsx.held` | The portal panel: your code, accepted count, create code, record a code | held: needs the shared UI package and the Runtime Kit |
| `do-work/read-portal-referrals.ts.held` | Browser session to the signed effect list to the state | held: calls `account-session.browser-session` and `signed-event-authority.list-effects` through `@bitfield/runtime-kit` |
| `do-work/send-referral-event.ts.held` | Signs and admits `referral.lifecycle` events, including `referral_code_applied` | held: calls `signed-event-author` and `signed-event-authority` through the Runtime Kit |
| `read-data/read-referral-state.ts` | Pure fold of effects into the newest code and the accepted-signup count | loads here |
| `index.ts.held`, `tests/mount-referrals-portal.test.tsx.held` | Package exports and the mount test | held with their modules |
| `README.md`, `things-to-store-and-run.json` | The package's own description and records | data |

`tests/read-referral-state.test.ts` was not carried: it holds a made-up account name and a tenant name that a public tree may not keep; the lead decides whether to swap them by a call row.
