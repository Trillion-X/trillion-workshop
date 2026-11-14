# Notifications Tests

This folder contains focused backend gates for the notifications package.

- `notifications-boundary.test.mjs` proves the boundary records use open
  policy/action/projection descriptors. It also used to reject local
  sender/provider code, by walking the package source and matching 13 regexes.
  **That walk is gone as of 2026-09-05.** Those 13 regexes were THREE invariants
  and they are now `source-file-rule` records in `../things-to-store-and-run.json`,
  collected by the declared runner with every other source rule in the corpus:
  this package names no delivery transport, no other domain's vocabulary, and no
  notification mode in a branch. The walk existed only because the rule collector
  once read a single manifest, so a package could not declare a rule about its own
  source; eighteen packages had written the same walk by the time that changed.
- `boundary-rules-fire-on-the-thing-they-forbid.test.mjs` proves each of those
  three rules FIRES on what it forbids and spares what it must: the vendored React
  bundle under `proof/harness/out/`, the tests, and other packages. It matters more
  here than usual, because **all three rules match zero source lines today**, and a
  rule reporting nothing is indistinguishable from a rule that cannot match. It
  also pins the one non-obvious choice: the mode rule declares NO `unit`, so it
  judges the whole file and still catches a `switch (` head split across lines.
- `notification-action-routes.test.mjs` proves side-effect-like intents point to
  existing authority execution routes.

These tests are source/proposal proof. Live Record Board completion still needs a
proof attachment written through the app's log-owned data path.
