# tools/host-tool-servers-and-sites/

Files more than one moved group imports, kept once.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Ported, held, not wired (Nov 20 2026)

`src/site-worker-policy.mjs` holds the pure rules of a site's own Worker from the old host (tag `the pre-retirement Worker host tag`): `validCron` and `cronMatches` (UTC minute matching, `src/site-worker-installation.mjs:151-176` at the tag), `pinnedWorkerPermissions` (a changed grant leaves the Worker offline, `src/site-worker-source.mjs:78-92`), and `siteUsesOriginalBackend` (linked original routes keep the original backend authoritative, `src/site-worker-installation.mjs:20-22`). It has no caller. Its tests are `test/site-worker-policy.test.mjs`. It is not in `moved-from.json`, because its functions are copied, not moved byte for byte.
