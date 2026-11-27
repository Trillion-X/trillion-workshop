# tools/let-someone-look-at-my-account-read/

Let someone use some of my Trillion tools, read only, through a share my own door keeps (not a look sign-in).

## How it works now

- `src/view-as.mjs` builds the share the engine keeps at the owner's door: `sharingKeepInput` (`sharing.keep` on `@own-records`, input `{label, on: true, sharing: {grant: {tools, identity, journal}, people, ends?}}`), `sharingWithdrawInput` (`sharing.withdraw`, input `{label}`), `shareLinkFor` (a bearer `shr_` plus 32 random bytes, base64url; the keep holds only its BLAKE3 digest), `endsAfterDays` (the person's end rule `{until}`, read by `tools/end-a-grant-whose-condition-failed`) and `sharingSections` (the Privacy section: a form, a link action, each share with Stop).
- The engine side is `trillion-rust src/account_rights/share_grant.rs` (keep, withdraw, bearer checks) and its DATA `src/account_rights/share-grant.json` (`act`: `keep_resource` `@own-records`, `keep_operation` `sharing.keep`, `withdraw_operation` `sharing.withdraw`, `most_label_bytes` 400, `most_people` 64).
- The caller passes the tools to share. This tool does not decide which tools are read only.
- Caps and words are DATA in `tools/view-as/src/view-as.json`.

## Retired (Nov 20 2026 ruling, relayed by the lead from main dude)

Verdict RETIRED for the look sign-in, its cookie and its banner. Ruling as relayed: the job "let someone look, read only, for a few days" is now a share grant of the read-only tools to that named person (`trillion-rust src/account_rights/share_grant.rs`). The looker signs in as themselves, because every actor is a user and the owner's look-only session is the special login that was removed. The days limit becomes `tools/end-a-grant-whose-condition-failed`. Its outcomes are still judged: "the owner can let one person use my read-only tools for a few days" is KEPT-DIFFERENTLY through the share grant (file:line above). Removed from the code in this folder: `lookSessionAllows`, `startLook`, `lookStands`, `takeLookLink`, `stopLetting`, `looking`, the `permissions` store and the owner-notice rules (`lookedNotice`, `keepLook`). The old `/view-as/...` and `/work/api/account/looking/...` routes are not served.

## Still open (not built here)

- How a person who signs in as themselves is named in `people`. A share's people are a bearer digest or a team pass (`{principal, team, issuer}`), and a signed-in account has neither here. `letLook` (email to account) is not kept: its people form needs a ruling.
- The owner's Privacy screen render. `sharingSections` is data; no screen renders it yet, and the tour `whats-new-2026-10-05-let-someone-look` still points at a Privacy section that does not exist.
- The end runner: `tools/end-a-grant-whose-condition-failed` (in `tools/share-anything`) reads `ends` as `{until}`; a live check of it with a share from this tool is not done.
- No `what-this-tool-does-and-how-to-run-it.json` in this folder. Other tools' `uses_tools` lists name this tool, so the names resolve to no row until a row exists.

## Tests

- `test/share-grant-input.test.mjs`: 7 tests (keep shape, end rule, caps refused in the owner's words, withdraw, day count, bearer and digest, Privacy send actions and no old route). Run: `env -u GIT_INDEX_FILE node --test tools/let-someone-look-at-my-account-read/test/share-grant-input.test.mjs`.
- `test/view-as-looked.test.mjs.held` and `test/view-as-owner-address.test.mjs.held` were the look sign-in tests; they are removed with the sign-in (their bytes are in git history at 73447d8fc and earlier).
