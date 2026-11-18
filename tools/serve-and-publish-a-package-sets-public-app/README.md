# tools/serve-and-publish-a-package-sets-public-app/

The public app host: one generic server source (`processes/public-entry-server-source.mjs`) that serves any package set's public pages from the page description that set carries (a host with no description answers 503 on purpose, not a blank 200), keeps the last good page description and kept prices across an engine outage, serves a recovering host only its own archive, refuses a public route a description retires, and answers a customer's own socket only for that customer. Around it: publication of a selected experience (`do-work/selected-publication-targets.ts`, `do-work/public-selection-transition.ts`, `do-work/request-publish-live-site.ts`), the processes that prepare publication records, materialize the hosted tree, prove a release starts before it goes live, check what a public address serves, publish a reviewed article and a document, and deploy to a provider (`processes/run-provider-deploy.mjs`, `tools/write-a-sales-page/packages/hosted-public-app/processes/provider-credential.mjs`). Moved byte for byte from bitfield-packages `packages/hosted-public-app` at its last commit. Machine-built files (`built-stored-bytes/`, `.bitfield-entry-scope/`, `package-preview.*.gz`), `proof/` captures and the package's `entry-to-package-data-map.json` are build output of the retired package builder and are not carried.

## Files

| File | Purpose |
|------|---------|
| `__tests__/README.md` | The package's own note, moved as written. |
| `__tests__/a-customer-socket-serves-only-its-own-request.test.mjs` | The package's code, moved as written. |
| `__tests__/a-description-names-its-files-where-it-lives.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/a-funnel-step-sells-the-price-option-it-names.test.mjs` | The fourth and last site of the price-option lane, and the one that had no test until now, |
| `__tests__/a-page-with-words-is-never-blank.test.mjs.held` | Held test: imports a file of another package that is not at the path the import names in this tree (checkout `read-offers`, ui `for |
| `__tests__/a-produced-file-holds-what-the-module-returned.test.mjs` | A produced file holds what the module returned, or the producer refuses and says why. |
| `__tests__/a-recovering-host-serves-only-its-own-archive.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/a-release-does-not-shrink-the-machines.test.mjs.held` | Held test: imports `pngjs` (and the browser checks `playwright`) |
| `__tests__/a-sign-in-page-can-load-its-own-code.test.mjs.held` | Held test: fails against the committed bytes of the package: the committed boundary file and the committed test disagree (the packa |
| `__tests__/a-tenant-with-no-island-still-gets-a-page.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/a-tenants-authored-files-answer-where-no-route-did.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/an-envelope-says-where-its-value-comes-from.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/an-unreviewed-article-row-cannot-replace-the-archive.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/anonymous-app-routes-stay-out-of-the-directory.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/app-shell-survives-a-dead-engine.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/archived-pages-for-tests.json` | Data the package carried as written. |
| `__tests__/asking-twice-for-a-certificate-is-safe.test.mjs` | The first version of this asked the provider to CREATE the certificate every |
| `__tests__/built-entry-server.mjs` | Test-only compilation of the generic server. The file is passed directly to this test process |
| `__tests__/buyer-artifact-absence.test.ts` | The package's code, moved as written. |
| `__tests__/buyer-authority-boundaries.test.ts` | The package's code, moved as written. |
| `__tests__/buyer-browser-context-isolation.test.ts` | The package's code, moved as written. |
| `__tests__/buyer-data-footprint.test.ts` | The package's code, moved as written. |
| `__tests__/buyer-identity-chain.test.ts` | The package's code, moved as written. |
| `__tests__/buyer-network-escape.test.ts` | ⛔ THIS ASSERTED A CALL SPELLING THAT NEVER EXISTED, and it failed the day the suite was |
| `__tests__/buyer-runtime.browser.spec.ts.held` | Held test: a Playwright browser spec |
| `__tests__/carrier-http-effect.test.mjs` | The package's code, moved as written. |
| `__tests__/chrome-for-tests.css` | Chrome for the test tenant, as a PLAIN CSS FILE with no export. |
| `__tests__/every-installed-package-set-description-renders.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/every-target-ask-says-which-targets-are-running.test.mjs` | ASKING A TARGET WITHOUT SAYING WHICH TARGETS YOU THINK ARE RUNNING IS REFUSED. |
| `__tests__/execute-definition-authority.test.ts.held` | Held test: fails against the committed bytes of the package: the committed boundary file and the committed test disagree (the packa |
| `__tests__/fallback-body-for-tests.html` | The package's code, moved as written. |
| `__tests__/hosted-entry-projection-selection.test.mjs` | The package's code, moved as written. |
| `__tests__/hosted-experience-authority-carrier.test.mjs.held` | Held test: imports `@bitfield/slot-protocol`, the retired package runtime's protocol package |
| `__tests__/hosted-public-app-backend.test.ts.held` | Held test: fails against the committed bytes of the package: the committed boundary file and the committed test disagree (the packa |
| `__tests__/kept-prices-survive-a-dead-engine.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/normalize-selected-publication-target.test.ts.held` | Held test: the file it loads uses a TypeScript parameter property |
| `__tests__/one-account-gets-one-workspace-it-can-reach.test.mjs` | Two failures this covers, both of which are silent. |
| `__tests__/one-binary-serves-two-tenants.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/page-description-for-tests.json` | Data the package carried as written. |
| `__tests__/page-shell-for-tests.css` | The page-shell stylesheet for the test tenant, deliberately unlike the live site's so a pass |
| `__tests__/protected-route-authority-wiring.test.mjs` | The package's code, moved as written. |
| `__tests__/public-landing-page-renders-without-an-engine.test.mjs.held` | Held test: bundles processes/public-entry-server-source.mjs with esbuild |
| `__tests__/publication-failure-semantics.test.ts.held` | Held test: fails against the committed bytes of the package: the committed boundary file and the committed test disagree (the packa |
| `__tests__/reading-a-public-page-stays-public.test.mjs` | This reaches the network, so what it REFUSES matters more than what it |
| `__tests__/restarting-is-not-rebuilding.test.mjs.held` | Held test: imports `pngjs` (and the browser checks `playwright`) |
| `__tests__/runtime-kit-test-tools.mjs` | The package's code, moved as written. |
| `__tests__/sealed-closure-integrity.test.mjs.held` | Held test: imports `@bitfield/slot-protocol`, the retired package runtime's protocol package |
| `__tests__/selected-experience-offline-build.test.mjs.held` | Held test: imports `@bitfield/slot-protocol`, the retired package runtime's protocol package |
| `__tests__/selected-experience-publication-e2e.test.mjs.held` | Held test: imports `@bitfield/slot-protocol`, the retired package runtime's protocol package |
| `__tests__/selected-experience-publication.test.ts` | The package's code, moved as written. |
| `__tests__/selected-publication-targets.test.ts.held` | Held test: the file it loads uses a TypeScript parameter property |
| `__tests__/seller-share-sell-flow.browser.spec.ts.held` | Held test: a Playwright browser spec |
| `__tests__/seller-share-sell-flow.test.ts.held` | Held test: fails against the committed bytes of the package: the committed boundary file and the committed test disagree (the packa |
| `__tests__/t14-remaining-accessibility.browser.spec.ts.held` | Held test: a Playwright browser spec |
| `__tests__/the-generic-server-names-no-tenant.test.mjs` | THE GENERIC SERVER NAMES NO INSTALLED TENANT, checked rather than asserted. |
| `__tests__/two-accounts-never-share-a-runtime-instance.test.mjs.held` | Held test: scans `package-sets/` of the original repository for every installed package set |
| `do-work/public-selection-transition.test.ts.held` | Held test: the file it loads uses a TypeScript parameter property |
| `do-work/public-selection-transition.ts` | The package's code, moved as written. |
| `do-work/request-publish-live-site.ts` | The package's code, moved as written. |
| `do-work/selected-publication-targets.ts` | The runner sends `runtime` AND `packageData`. This type named only the second, |
| `from-bitfield-packages/README.md` | The package's own note, moved as written. |
| `index.ts` | The package's code, moved as written. |
| `processes/ask-the-host-provider-for-a-certificate.mjs` | PURPOSE |
| `processes/carrier-http-effect.mjs` | The HTTP `/target/*` response body is already the transport for target bytes. |
| `processes/check-the-live-update-lane-answers.mjs` | Ask a public host whether its LIVE UPDATE LANE completes a protocol upgrade. |
| `processes/compose-article-discovery.mjs` | The package's code, moved as written. |
| `processes/compose-article-discovery.test.mjs` | The package's code, moved as written. |
| `processes/document-parts.mjs` | The parts of an HTML document, for code that has one and needs the other. |
| `tools/write-a-sales-page/packages/hosted-public-app/processes/flatten-current-container-base.mjs` | The package's code, moved as written. |
| `processes/flatten-current-container-base.test.mjs` | The package's code, moved as written. |
| `processes/hosted-url-return-action.mjs` | The package's code, moved as written. |
| `processes/hosted-url-return-action.test.mjs` | The package's code, moved as written. |
| `processes/materialize-hosted-projection-tree.mjs` | The package's code, moved as written. |
| `processes/materialize-hosted-projection-tree.test.mjs.held` | Held test: imports `@bitfield/slot-protocol`, the retired package runtime's protocol package |
| `processes/offer-price-observations.mjs` | derived in packages/checkout/read-data/read-offers.ts) its two observed counts: |
| `processes/offer-price-observations.test.mjs.held` | Held test: imports a file of another package that is not at the path the import names in this tree (checkout `read-offers`, ui `for |
| `processes/open-the-workspace-for-one-account.mjs` | Open the runtime instance that belongs to ONE account, and say where it listens. |
| `processes/persistent-entry-styles.mjs` | The browser replaces the entry root when its current scene paints. Anything marked as |
| `processes/prepare-publication-records.mjs` | The package's code, moved as written. |
| `processes/prepare-publication-records.test.mjs.held` | Held test: imports `@bitfield/slot-protocol`, the retired package runtime's protocol package |
| `processes/prove-a-release-host.test.mjs.held` | Held test: imports `pngjs` (and the browser checks `playwright`) |
| `processes/prove-a-release-starts-before-it-goes-live.mjs` | started from that release on a copy of the app's own data, says it is fully |
| `tools/write-a-sales-page/packages/hosted-public-app/processes/provider-credential.mjs` | Read the hosting provider credential without putting it in arguments, output, |
| `processes/public-entry-server-source.mjs` | The package's code, moved as written. |
| `processes/public-route-retirement.mjs` | The package's code, moved as written. |
| `processes/public-route-retirement.test.mjs` | The package's code, moved as written. |
| `processes/publish-current-document.mjs` | Native publication owner. The session is the selected running-app transport, |
| `processes/publish-current-document.test.mjs.held` | Held test: imports `pngjs` (and the browser checks `playwright`) |
| `tools/write-a-sales-page/packages/hosted-public-app/processes/publish-reviewed-article.mjs` | Replace the one archived Article at the same route, preserving every other |
| `processes/publish-reviewed-article.test.mjs.held` | Held test: imports `pngjs` (and the browser checks `playwright`) |
| `processes/read-one-public-page.mjs` | PURPOSE |
| `processes/render-article-candidate.mjs` | The package's code, moved as written. |
| `processes/render-article-candidate.test.mjs.held` | Held test: imports `pngjs` (and the browser checks `playwright`) |
| `processes/report-what-a-public-address-serves.mjs` | Report what a public address actually serves, in words. |
| `processes/run-provider-deploy.mjs` | Advance the shared product log through its existing atomic package-delta |
| `processes/run-provider-deploy.test.mjs.held` | Held test: imports `pngjs` (and the browser checks `playwright`) |
| `processes/runtime-instance-for-this-request.mjs` | Which runtime instance answers THIS request. |
| `processes/runtime-upstream-transport.mjs` | The front door selects one verified customer's upstream before reaching this |
| `tools/write-a-sales-page/packages/hosted-public-app/processes/verify-release-viewport-paint.mjs` | A signed-in journey can enter a member route such as /account after the |
| `processes/write-a-module-export-result-to-a-file.mjs` | Call one export of one module and write what it returns to a file. |
| `read-data/__tests__/page-cta-price.test.ts.held` | Held test: imports a file of another package that is not at the path the import names in this tree (checkout `read-offers`, ui `for |
| `read-data/artifacts/app-api-experience-bytes-route.ts.txt` | The package's code, moved as written. |
| `read-data/artifacts/app-api-experience-data-route.ts.txt` | The package's code, moved as written. |
| `read-data/artifacts/app-api-experience-manifest-route.ts.txt` | The package's code, moved as written. |
| `read-data/artifacts/app-api-experience-subscriptions-route.ts.txt` | The package's code, moved as written. |
| `read-data/artifacts/app-globals.css.txt` | { |
| `read-data/artifacts/app-layout.tsx.txt` | The package's code, moved as written. |
| `read-data/artifacts/app-next.config.mjs.txt` | @type {import("next").NextConfig} |
| `read-data/artifacts/app-page.tsx.txt` | The package's code, moved as written. |
| `read-data/artifacts/app-robots.ts.txt` | The package's code, moved as written. |
| `read-data/artifacts/app-sitemap.ts.txt` | The package's code, moved as written. |
| `read-data/artifacts/app-tsconfig.json.txt` | The package's code, moved as written. |
| `read-data/artifacts/hosted-experience-authority.ts.txt` | Server-only authority for one published experience. |
| `read-data/artifacts/hosted-surface-client.tsx.txt` | The package's code, moved as written. |
| `read-data/artifacts/hosted-surface-page.tsx.txt` | The package's code, moved as written. |
| `read-data/artifacts/hosted-target-carrier-client.tsx.txt` | The package's code, moved as written. |
| `read-data/artifacts/hosted-target-carrier-server.ts.txt` | Server-only transport for one authority-bound hosted experience. |
| `read-data/artifacts/hosted-target-route.ts.txt` | The package's code, moved as written. |
| `read-data/artifacts/site.webmanifest.txt` | The package's code, moved as written. |
| `read-data/described-file-at.mjs` | WHERE A FILE NAMED BY A PAGE DESCRIPTION ACTUALLY IS. |
| `read-data/named-price-option.mjs` | Which option of a linked offer a funnel step sells, NAMED rather than inferred from position. |
| `read-data/operational-record-projection.ts` | The package's code, moved as written. |
| `read-data/package-store-metadata.ts` | The package's code, moved as written. |
| `read-data/page-cta-price.mjs` | Resolve the current amount named by a public page record. |
| `read-data/release-machine-settings.json` | Data the package carried as written. |
| `things-to-store-and-run.json` | Data the package carried as written. |
| `moved-from.json` | Where each file came from: source path and commit in bitfield-packages, the identity of its source bytes and of its bytes here, the call rows applied, the held tests and the files that still call the retired runtime. |
| `part.json` | Nothing here is imported by this tree; the folder is a part another tree imports. |
| `README.md` | This file |

The original package README is kept at `from-bitfield-packages/README.md`. The provider deploy talks to one retired hosting provider with a credential read by `tools/write-a-sales-page/packages/hosted-public-app/processes/provider-credential.mjs`; that group is held (the door hands credentials by handle through a row's `invoke.connection`), so none of it is edited here.

## Still on the retired runtime

These files are the original bytes, with import paths changed to this tree. They call the retired package runtime or a package path this tree does not hold, so no tool row opens them until each call is swapped for the records door.

- `__tests__/built-entry-server.mjs`: retired package build alias
- `__tests__/runtime-kit-test-tools.mjs`: retired package runtime
- `do-work/public-selection-transition.ts`: retired package runtime
- `do-work/selected-publication-targets.ts`: retired package runtime
- `processes/materialize-hosted-projection-tree.mjs`: retired slot protocol
- `processes/prepare-publication-records.mjs`: retired slot protocol
- `processes/public-entry-server-source.mjs`: retired package build alias

## Held tests

Each is the package's test file, same bytes, named `.held` so no test run picks it up; the reason is in `moved-from.json` under `held`.

- `__tests__/a-description-names-its-files-where-it-lives.test.mjs.held`
- `__tests__/a-page-with-words-is-never-blank.test.mjs.held`
- `__tests__/a-recovering-host-serves-only-its-own-archive.test.mjs.held`
- `__tests__/a-release-does-not-shrink-the-machines.test.mjs.held`
- `__tests__/a-sign-in-page-can-load-its-own-code.test.mjs.held`
- `__tests__/a-tenant-with-no-island-still-gets-a-page.test.mjs.held`
- `__tests__/a-tenants-authored-files-answer-where-no-route-did.test.mjs.held`
- `__tests__/an-envelope-says-where-its-value-comes-from.test.mjs.held`
- `__tests__/an-unreviewed-article-row-cannot-replace-the-archive.test.mjs.held`
- `__tests__/anonymous-app-routes-stay-out-of-the-directory.test.mjs.held`
- `__tests__/app-shell-survives-a-dead-engine.test.mjs.held`
- `__tests__/buyer-runtime.browser.spec.ts.held`
- `__tests__/every-installed-package-set-description-renders.test.mjs.held`
- `__tests__/execute-definition-authority.test.ts.held`
- `__tests__/hosted-experience-authority-carrier.test.mjs.held`
- `__tests__/hosted-public-app-backend.test.ts.held`
- `__tests__/kept-prices-survive-a-dead-engine.test.mjs.held`
- `__tests__/normalize-selected-publication-target.test.ts.held`
- `__tests__/one-binary-serves-two-tenants.test.mjs.held`
- `__tests__/public-landing-page-renders-without-an-engine.test.mjs.held`
- `__tests__/publication-failure-semantics.test.ts.held`
- `__tests__/restarting-is-not-rebuilding.test.mjs.held`
- `__tests__/sealed-closure-integrity.test.mjs.held`
- `__tests__/selected-experience-offline-build.test.mjs.held`
- `__tests__/selected-experience-publication-e2e.test.mjs.held`
- `__tests__/selected-publication-targets.test.ts.held`
- `__tests__/seller-share-sell-flow.browser.spec.ts.held`
- `__tests__/seller-share-sell-flow.test.ts.held`
- `__tests__/t14-remaining-accessibility.browser.spec.ts.held`
- `__tests__/two-accounts-never-share-a-runtime-instance.test.mjs.held`
- `do-work/public-selection-transition.test.ts.held`
- `processes/materialize-hosted-projection-tree.test.mjs.held`
- `processes/offer-price-observations.test.mjs.held`
- `processes/prepare-publication-records.test.mjs.held`
- `processes/prove-a-release-host.test.mjs.held`
- `processes/publish-current-document.test.mjs.held`
- `processes/publish-reviewed-article.test.mjs.held`
- `processes/render-article-candidate.test.mjs.held`
- `processes/run-provider-deploy.test.mjs.held`
- `read-data/__tests__/page-cta-price.test.ts.held`

## Dependencies

**Depends on:** `tools/keep-lists-of-rows` (the visual-database read model), the shared ui parts of the web client, Node 24.

**Depended on by:** nothing yet; a tool row and its screen wiring come once the held calls are swapped.
