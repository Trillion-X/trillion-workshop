# tools/keep-a-shared-checkout-on-main/

Keeps a repository's shared checkout on origin/main after a landing that pushed by plumbing (a private index, so the checkout's own HEAD and files stayed behind), without losing a byte of anyone's work.

The control repository's landing helper (`lane-land.py`, `advance_primary_checkout`) runs `scripts/advance-shared-checkout.mjs` after every landing. It exports this folder from origin/main of this repository (the control repository's `checkout-advancer.json` names the owner, the ref, the export path and the script) and runs the script from the export against the landed repository's checkout, with `--if-shared --if-idle`. A landing prints `advance:` lines; a missing script prints `checkout not advanced`.

| File | What it does |
|------|--------------|
| `scripts/advance-shared-checkout.mjs` | Moves a checkout's HEAD to origin/main. Refuses a shallow repository, a HEAD that does not descend to main, a content filter or line-ending conversion. Takes `index.lock`, writes main's bytes only where disk equals HEAD, keeps and lists every local version (saved at `refs/rescue/advance-*`), moves HEAD by compare-and-swap. |
| `scripts/commit-on-current-main.mjs` | Refuses a commit that does not build on the newest main; the advancer asks it whether a checkout is the shared one. |
| `scripts/hooks-from-main.mjs` | Points `core.hooksPath` at the hooks in a read-only export of main; the advancer runs it after a move. |
| `scripts/one-checkout.mjs` | Refuses a second checkout of the repository. The reference-transaction hook starts it. |
| `scripts/git-hooks/reference-transaction` | The hook that judges every ref update. |
| `scripts/without-git-location.mjs` | An environment without git's location variables, for tests. |
| `test/advance-shared-checkout.test.mjs` | Runs the advancer in real repositories with a real origin and the hook. |

Every file came from trillion-apps `29972ae5^` byte for byte, written in old Trillion at `5dc302be37`; `moved-from.json` names each source, commit and identity. Commit `29972ae5` deleted the port from trillion-apps `web/` as dead although the landing helper still ran it.

Tests: `node --test --test-force-exit 'tools/keep-a-shared-checkout-on-main/test/*.mjs'` (10 pass; `test/support/` holds the fixture's git environment, which is not a test).
