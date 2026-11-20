# tools/let-someone-look-at-my-account-read/

Let someone look at my Trillion read only for a few days, exactly as I see it, with every change refused.

This folder has no row yet. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Ported here (from the old app repository, commit b6ae0ebf815f, see `moved-from.json`)

- `src/view-as.mjs`: the rules of letting someone look. The owner lets one person look by email for 1, 3 or 7 days, or makes a one-use link; a look is read only and ends at `look_minutes`; stopping ends it; the owner is told each look; the newest `kept_looks` are kept. Also `lookSessionAllows`, the look-only gate (GET and HEAD, the page and `/work/api/` reads, until it ends), ported from old `src/screen-pictures.mjs`. Words and numbers are DATA in `tools/view-as/src/view-as.json`; the email lookup is `tools/start-from-any-landing-page/src/sign-in-email.mjs`.
- `test/view-as-rules.test.mjs`: 6 tests, the outcomes of the old held tests `test/view-as.test.mjs`, `test/view-as-looked.test.mjs` and `test/view-as-owner-address.test.mjs` (run with `node --test tools/let-someone-look-at-my-account-read/test/view-as-rules.test.mjs`).

## Still to port (lost or unwired; each is a To do row)

- The permission store: the owner's policy directory (old `src/account-control.mjs:1712-1790`, `letLookGrant`, `letLookStop`, `letLooking`, `letLookPermission`, `acceptsLook`). Nothing in the current code keeps a leave. The per-request check that stops a leave from opening a look open now (old `src/account-policy-source.mjs:82-91`) is not ported.
- The routes: `POST /work/api/account/looking/let|link|stop` (old `src/account-routes.mjs:812-835`), `GET /view-as/<id>` and `GET /view-as/link/<code>` and `GET /view-as/stop` (old `src/worker.mjs:4050-4090`). Nothing in the current code serves them.
- The look sign-in: the session the look starts (old `startLook` writes `session:<hash>`), the looker's own sign-in held in its own cookie, and the banner `looking_banner` (old `src/account-routes.mjs:1113-1122`).
- The read-only refusal is half there. The engine refuses a read-only browser scope's changes at `tools/workspace-screens/engine/src/workspace_domain.rs:1037-1039`, and has an issuer for that scope at `tools/workspace-screens/engine/src/workspace_session.rs:334` (`authorize_read_only`). Nothing in Workshop calls the issuer, so no look gets a read-only scope (LOST-UNWIRED).
- The owner's record of who looked and the notice (old `src/account-control.mjs:1738-1751` `noteAccountLooked`/`accountLookedAtBy`; old `src/person-store.mjs:8970`). `keepLook` and `lookedNotice` here are the rules only.
- The Privacy screen: `lookingSections` is ported, but no screen renders it. The tour `tools/workspace-screens/web/src/workspace/walkthroughs/whats-new-2026-10-05-let-someone-look.json` points at this section on Privacy, which does not exist in the current screens.
