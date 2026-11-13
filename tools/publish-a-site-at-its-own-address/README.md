# tools/publish-a-site-at-its-own-address/

Publishes a website's files into the person's own files and gives it its own address: a readable name under
trillion.run, or the person's own domain. Every address is one row of the account's origins list
(`/installations/origins.json`); the person's computer signs that list with the account's key and hands it to the
forwarder, which carries a request for that host to the computer, and the computer answers it from the site's files
(Trillion-X/trillion-rust `src/forwarder/origins.rs`, `src/native_entry/computer/installations.rs`).

## Files

| File | Purpose |
|------|---------|
| `read-data/site-addresses.mjs` | `publishSite`, `nameSite`, `attachDomain`, `letGo`, `siteAddresses`: each reads and writes the origins list and the site's files through the run's door (`tools/records-door`). |
| `read-data/site-addresses.json` | The folder, the list file, the names host, the name rules (old trillion `src/public-app-names.json`), the DNS record words and every refusal. |
| `tool-rows.json` | `tool:publish_site`, `tool:name_site`, `tool:attach_domain`, `tool:let_go_of_site_address`, `tool:site_addresses`. |
| `part.json` | Nothing here is imported by other code. |
| `test/site-addresses.test.mjs` | Tests, run by `npm test`. |
| `web/src/public-site-pages.mjs` | `publicSitePage(request)`: a signed-in app article read answers a redirect to the public site that owns it; every other read and every write stays with the app router. Moved byte for byte from the web client (`moved-from.json`). |
| `web/test/public-site-pages.test.mjs` | The redirects for article reads, and the reads and writes that stay. |

## Ported from old trillion

From tag `old-trillion-before-worker-retire`: `src/public-app-names.mjs:79` `checkedPublicAppName`, `:85`
`publicAppNameBasis`, `:140` `retirePublicAppName` (a renamed site keeps `moved_to`); `src/readable-names.mjs:47`
LOOKS_LIKE_CODE and `:54` `nameFromWords`; `src/public-app-domains.mjs:36` `hostOf` and `:44` `describe` (the TXT
record, here naming the account rather than a stored token, and the address record); `src/share-link-routing.mjs:16`
`normalizeShareDomain`. The site files are checked by `tools/shared-code/src/public-app-files.mjs`
`checkedPublicAppFiles`, moved earlier from the same app. The old central name and domain lists (APP_KV) and the
hosting provider calls are not ported: the list is the account's own, and a certificate is made by a TLS terminator
the forwarder answers (`/origins/certificate`).

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`, `whole-file.mjs`), `tools/shared-code`
(`public-app-files.mjs`, which needs `@noble/hashes`), Node's standard library.
