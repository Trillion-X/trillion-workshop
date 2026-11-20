# tools/let-someone-look-at-my-account-read/

Let someone look at my Trillion read only for a few days, exactly as I see it, with every change refused.

This folder has no row yet (no `tool-rows.json`), so nothing here is wired into a tool row. Its old files were the bytes of tag `old-trillion-before-worker-retire` (commit b6ae0ebf815f), moved here under their old paths. `moved-from.json` names each file's source path, commit and BLAKE3 identity; `part.json` names the repositories that import this part.

The `from-an-older-version/` folder is gone: its files now live in the places below. A file that cannot load or pass here yet is held: its name ends in `.held` (the same bytes), and the paragraphs below say what it waits for.

## Where each old file lives now

| Old path (b6ae0ebf815f) | Here | Status |
|---|---|---|
| `src/view-as.mjs` | `src/view-as.mjs` | ported (commit d1ed333fd431937e574d4da20d449f806414fa44). The parked copy was removed in the verify-every-port L05 commit: every function body is the same, except the permission id context string (`let-someone-look permission 2026-10-05`) and the section id `homes-i-can-look-at` (the old section id had the old brand word). |
| `test/view-as.test.mjs` | `test/view-as-rules.test.mjs`, `test/view-as-stop-ends-look.test.mjs` | revived as real tests (the held file's four tests: the rules and the Privacy and link tests run in `view-as-rules`; the stop-ends-look test runs in `view-as-stop-ends-look`, with the owner's live directory still to port, H1) |
| `test/view-as-looked.test.mjs` | `test/view-as-looked.test.mjs.held` | held: imports `src/local-store.mjs`, `test/import-source-for-tests.mjs`, `test/engine-tools-for-tests.mjs`, `src/account-control.mjs` (at the tag, not here). Its rule parts (kept looks, one notice per look) are in `view-as-rules`; its store part waits for H5. |
| `test/view-as-owner-address.test.mjs` | `test/view-as-owner-address.test.mjs.held` | held: imports `src/local-store.mjs`, `src/account-policy-name.mjs`, `src/account-control.mjs` (at the tag, not here). It waits for H1 (the owner's permission directory, addressed by the owner's id). |

`src/view-as.mjs` (the rules of letting someone look) and `test/view-as-rules.test.mjs` and `test/view-as-stop-ends-look.test.mjs` are the tests to run: `env -u GIT_INDEX_FILE node --test tools/let-someone-look-at-my-account-read/test/view-as-rules.test.mjs tools/let-someone-look-at-my-account-read/test/view-as-stop-ends-look.test.mjs`.

## Ported here (rules only)

- `src/view-as.mjs`: the rules of letting someone look. The owner lets one person look by email for 1, 3 or 7 days, or makes a one-use link; a look is read only and ends at `look_minutes`; stopping ends it; the owner is told each look; the newest `kept_looks` are kept. Also `lookSessionAllows`, the look-only gate (GET and HEAD, the page and `/work/api/` reads, until it ends), ported from old `src/screen-pictures.mjs`, and `lookStands`, the per-request check that stops a leave from opening a look open now (ported from old `src/account-policy-source.mjs:85-93` in the verify-every-port L05 pass; its caller is H1). Words and numbers are DATA in `tools/view-as/src/view-as.json`; the email lookup is `tools/start-from-any-landing-page/src/sign-in-email.mjs`.
- `test/view-as-rules.test.mjs`: 6 tests, the outcomes of the old held tests (leave refusals, look and its end, the Privacy sections, the link, the notice and kept looks, the look-only gate).
- `test/view-as-stop-ends-look.test.mjs`: 2 tests, the revived `test/view-as.test.mjs.held` (stop ends an open look at once) and the `lookStands` cases (disconnect, browser generation, ended sign-in, retired or deleting account, another viewer).

## Still to port (lost or unwired; each is a To do row under verify-every-port/let-someone-look-at-my-account-read)

- H1 The permission store: the owner's policy directory (old `src/account-control.mjs:1712-1790`, `letLookGrant`, `letLookStop`, `letLooking`, `letLookPermission`, `acceptsLook`), keyed by the owner's id. Nothing in the current code keeps a leave. `lookStands` is ready for its per-request call.
- H2 The routes: `POST /work/api/account/looking/let|link|stop` (old `src/account-routes.mjs:812-835`), `GET /view-as/<id>`, `GET /view-as/link/<code>`, `GET /view-as/stop` (old `src/worker.mjs:4050-4090`). The Worker that served them is retired (commit 4ffa1dc4a2); the gateway is the owner of the routes.
- H3 The look sign-in: the session a look starts (old `startLook` writes `session:<hash>`), the looker's own sign-in held in its own cookie, and the banner `looking_banner` (old `src/account-routes.mjs:1113-1122`). The gateway's sign-in refuses look-only records today (`trillion-rust` has no look-only support; `docs/sign-in-port/C-passkeys-sessions.md` question Q16).
- H4 The read-only refusal is half there. The engine refuses a read-only browser scope's changes at `tools/workspace-screens/engine/src/workspace_domain.rs:1037-1039`, and has an issuer for that scope at `tools/workspace-screens/engine/src/workspace_session.rs:334` (`authorize_read_only`). Nothing calls the issuer, so no look gets a read-only scope (LOST-UNWIRED).
- H5 The owner's record of who looked and the notice (old `src/account-control.mjs:1738-1751` `noteAccountLooked`/`accountLookedAtBy`; old `src/person-store.mjs:8970`). `keepLook` and `lookedNotice` here are the rules only.
- H6 The Privacy screen: `lookingSections` is ported, but no screen renders it. The tour `tools/workspace-screens/web/src/workspace/walkthroughs/whats-new-2026-10-05-let-someone-look.json` points at this section on Privacy, which does not exist in the current screens.
- H7 The owner's times: `shortDay` formats in UTC (old `src/view-as.mjs:173`). A product decision for the owner about the time zone a look shows.
- H8 A live proof on the new route (old `scripts/prove-view-as.mjs`), after H2 and H3.
- H9 No `tool-rows.json` in this folder, yet 235 `uses_tools` lists in other tools' `tool-rows.json` name `trillion-workshop/let-someone-look-at-my-account-read`. Those names resolve to no row until a row exists (wiring is H1 to H6 in the owner).
