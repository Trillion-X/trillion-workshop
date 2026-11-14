# hosted-public-app

Package source workshop for the public app hosting owner.

## One contained publication operation

The publication workflow mounts the selected bytes once, verifies them, and invokes the package-owned
deployment profile in the same contained process workspace. Package-set DATA cannot provide a build
or deployment command, and there is no separately addressable tenant build directory.

`processes/public-entry-server-source.mjs` is the generic server source. One source serves many
package sets; each set supplies DATA rather than owning a server copy. Publication preparation lives
in `processes/prepare-publication-records.mjs`, materialization lives in
`processes/materialize-hosted-projection-tree.mjs`, and the deploy step invokes
`processes/run-provider-deploy.mjs` inside the already-contained workflow workspace.

## The page description, which this host REQUIRES

Since 2026-09-05 the page shells hold no tenant's copy. A host must be told who it serves or it
answers **503** on its public pages, deliberately, because the alternative is a 200 that looks
structurally fine and is blank to a visitor.

| Source | Where |
|---|---|
| engine records | `package-set-records::public-page-description-records` |
| file, when the engine is down | `BITFIELD_PUBLIC_PAGE_DESCRIPTION_FILE` |
| kept across restarts | `${BITFIELD_INSTALL_ROOT}/last-good-page-description.json`, written automatically |

**A source yields a LIST**, under `pages` in a file or `rows` from a record, even for one
tenant, so a second tenant is a ROW rather than a deploy. A bare object is refused on purpose:
it would work, and two shapes meaning one thing is how a format grows a dialect.

**One entry serves every host this process answers for** and needs no `hosts` key. **Many must
each declare `hosts`**, and an undescribed host gets a 503 rather than an arbitrary tenant.
Matching is only needed when there is a choice, which is why the single-tenant case writes
nothing: `BITFIELD_HOST_ENTRY_SCENE_HOSTS` says which hosts this process answers for at all,
and the description says who each host IS. Different questions, so neither is derived from the
other.

A package set carries its own at `<package-set>/deploy/page-description.json`, and the build
warns when one is absent. It supplies `title`, `meta_description`, `brand`, `language`, `theme`,
`island` (`mount_element_id`, `bundle_url`, `stylesheet_url`, `inline_css`, `noscript_route`,
`state_envelopes`), `thank_you`, and the server-rendered chrome:

A page description may also declare `retired_routes` with `exact_paths` and
`path_prefixes` arrays. The public server answers matching GET and HEAD requests
with 404 before rendering or proxying them. These routes belong to the tenant's
description; adding or retiring a tenant route does not require a server fork.
Other methods and hosts retain their existing routing. Malformed path lists do
not become wildcard matches.

| Field | Meaning |
|---|---|
| `chrome_css_file` | absolute path to the tenant's chrome, READ AT RUNTIME |
| `chrome_css_export` | the named export to take from it; **absent means the file IS the css** |
| `shell_css_file` | absolute path to the stylesheet for pages this server renders ITSELF |
| `shell_css_export` | the named export to take from it; absent means the file IS the css |
| `fallback_body_file` | absolute path to the tenant's editorial body, a FRAGMENT the shell wraps |
| `fallback_pages_file` | absolute path to the archived pages THIS host may still serve while the engine recovers, as `{"rows":[…]}` where each row is a `public-sales-page` record with an `id` and a `route_path`. Optional: a tenant that declares none serves none, which is the correct answer rather than a gap. **This was a 4.4 MB import inside this package until 2026-09-09**, so one tenant's 385 articles were bundled into every tenant's binary and matched by `route_path` alone, with no host or partition scoping: any host asked for one of those paths answered with another customer's page. An archive of a tenant's pages is the tenant's |
| `checkout_title` | the document title on the checkout page when no offer is selected; absent serves `Checkout`, which names the page rather than borrowing a company |
| `landing_offers` | which offer fills which landing envelope AND what that envelope carries, keyed by the SAME names `island.state_envelopes` maps to. Each entry is `{offer_id, fields}`, and each field says its source as structure: `{"from": "offer" \| "price_option", "key": "..."}`. No defaults; an undeclared envelope yields an unavailable card |
| `lead_capture` | how a lead submitted to this host describes itself to the owners that file it: `contact_source`, `contact_source_ref`, `activity_ref_prefix`, `note`, `channel` |
| `per_account_runtime` | this host serves SIGNED-IN PEOPLE, so it resolves a different upstream per account. See the section below |

## A host that serves signed-in people, `per_account_runtime`

**The shell this server proxies to cannot tell two customers apart.** Its partition is a
process-wide environment value read at every read and write path, and its `/target/*` gate is one
shared token compared against one header, with the target-admission predicate judging the target
NAME rather than the caller. Meanwhile engine operations take `partition_label` out of the
caller's own JSON body. A single shell handed two customers therefore serves each of them the
other one, every time, and it answers 200 while doing it.

So a described host may declare `per_account_runtime`, and the request is then routed to one of
TWO kinds of instance:

| kind | how many | owns |
|---|---|---|
| directory | one, shared | sign-in and accounts, nothing else |
| workspace | one per account | that person's work |

The directory exists because a request that is trying to BECOME somebody has to reach something,
and it cannot be the asker's own instance because there is no asker yet.

| Field | Meaning |
|---|---|
| `directory_shell_url` | where the shared directory instance listens. Required |
| `sign_in_route` | where a visitor with no session is sent. Required, and always treated as a directory route even when the prefixes below omit it, because a binding that forgot to repeat it is a redirect loop |
| `directory_route_prefixes` | which paths are owned by the directory. Ownership does not make a target public. A target under one of these prefixes still requires a verified session unless its exact path is named in `public_directory_targets`. Matched at a segment boundary, so `/auth` does not claim `/authorize-my-account` |
| `public_directory_targets` | exact `/target/<name>` paths callable before sign-in, such as the login-link request. No family prefix or neighbouring target inherits public access |
| `workspace.root_directory` | retired for hosted accounts: direct local launch is refused because the public front door cannot confine customer code |
| `workspace.open_target` | the declared owner that opens a confined customer worker and returns its verified socket |
| `workspace.package_set` | which package set this account's workspace runs. Opaque here, forwarded whole, and the reason giving one group of customers a different set of packages is a row rather than a deploy |
| `workspace.authorize_session_target` | which directory target proves a session. Defaults to `account-session.authorize-transient-session` |

**Declaring `root_directory` is refused, including when `open_target` is also declared.**
The customer worker belongs to the confined process owner, not the public front door.

**The principal never comes from the request.** Every header the browser sent is forwarded to the
directory as EVIDENCE, and the directory's reply is the only thing that establishes who is asking.
A header naming a principal is a claim, and if any of them could be believed the whole boundary
would be one `curl` away from nothing.

**Five answers, and the two middle ones are why this is not a boolean.** A directory route reaches
the directory. A verified account reaches its own workspace. No session, or a session the
directory rejects, is sent to sign in. A workspace still BOOTING gets a page that says so, because
nothing is wrong and holding the visitor's socket open for a cold boot would turn a slow boot into
a timeout they read as the product being broken. Everything else is refused: a directory that
cannot answer is NOT a visitor without a session, a starter that opened nothing does not fall back
to a configured shell, and a workspace may not resolve to the directory, which is the one instance
every other customer is allowed to reach.

**A host declaring no `per_account_runtime` is byte-unchanged**, which is what keeps every
existing tenant on the single-upstream path it has today.

Any description key ending in **`_file`** is an absolute path the build checks exists, so adding
a described file needs no build edit. The `_export` siblings are excluded by the same rule.
(The paragraph above used to sit between two table rows, splitting one table into two.)

**Landing offers are PER TENANT, and were per process until 2026-09-05.** One cache file, one
in-memory value, one throttle, one keeper at module scope with no request in hand, so two tenants
on one binary shared one set of prices. Each tenant now has its own of all four, keyed by its own
first declared host so a tenant serving several hostnames keeps one set. The keeper being per
tenant is the important half: its third invariant is that a source answering with NOTHING must
not overwrite a good kept value, and a shared keeper let one tenant's silence discard another's
prices. `landing_offers` moved into DATA only AFTER that scoping, deliberately: ids-first would
have handed every tenant the same offers under different names. **The envelope KEY SET is not
enumerated anywhere in the server.** It was, in four places at once, and the fourth was found by
requiring a novel key to reach the page rather than by requiring another tenant's values to be
absent, which the broken code already satisfied. A new envelope is a row in `landing_offers` plus
a row in `island.state_envelopes`, and zero code. The one rule the server still enforces on the
projected values is stated as a rule rather than as a field name: every declared numeric field
must be a safe integer above zero, because nothing upstream checks positivity and a non-positive
price kept would displace a good one. The old process-wide
`landing-offers-cache.json` is still read so a deploy does not lose its prices, but it is CLAIMED
rather than inherited: it carries the offer ids it was built from, and only the tenant declaring
those ids may take it.

**`lead_capture` is stamped onto the queued lead at capture time, NOT read by the drain.** The
drain runs at startup and on a timer with no request in hand, so the tenant is knowable only while
the request is live; reading these from process config would file every tenant's leads under one
name. A tenant that omits the key, and every record queued before 2026-09-05, still captures and
still drains, with attribution naming the MECHANISM (`public-entry-application`, "Applied through
the public entry form") rather than guessing a product. **A guessed attribution is
indistinguishable from a correct one**, so silence beats a plausible name. The fallback merges per
key, so declaring one value does not forfeit the other four.

**The island asset prefix is DERIVED from `island.bundle_url`, not configured.** That URL already
states where this tenant's assets live, and a second field saying the same thing is two sources
of truth one typo apart. It was a constant until a real second package set was built and its
island 404ed, because the static route only answered under the first tenant's prefix. The prefix
is validated for traversal now: as a constant it could not contain one, and as data it can while
still being joined to a directory on disk.

**`shell_css_file` is not a duplicate of `chrome_css_file` and merging them would be wrong.**
The chrome is entirely `.public-sales-page__*`, styling the sales-page renderer's output; the
shell styles the editorial body and thank-you page, which are this server's own markup. Disjoint
selectors, verified by listing both. They share a category name, "this tenant's CSS", and a
shared category name is not shared truth. What IS shared is the READING, through `tenantCssAt`.

An absent `shell_css_file` serves an UNSTYLED page rather than refusing, unlike an absent
`fallback_body_file`. A missing body is blank and tells a visitor nothing, so 503 is kinder; a
missing stylesheet is ugly and completely readable, so refusing would take a working page away.
Both are logged.

`fallback_body_file` is a document rather than a described list of sections, and that is a
decision rather than a shortcut. A `sections` list would make this server know the NAME of every
section kind, so the tenant wanting one it lacks would edit this package and the vocabulary
would grow one entry per customer. This page only renders when the engine cannot answer; the
generic form of an emergency page is a document its owner wrote, so adding a tenant adds a file.

**A described host with no readable body answers 503**, with its own message naming the file
path, distinct from the missing-description 503 above. A blank file counts as absent: a
present-but-empty body renders a 200 that passes every structural check and shows a visitor
nothing.

The chrome is referenced rather than copied because that file is the single source for two
consumers, this server and `build-document-attachment-records.mjs`, and their divergence caused
a real regression once. `chrome_css_export` exists so the reader never guesses from a file
extension: one tenant ships a module exporting a template literal, the next ships plain `.css`,
and adding either changes no code.

**Do not add a default description to this package.** A default is one tenant's copy compiled
back into the generic package under a new name, so a second tenant would still cost a code
change, which is exactly what this removed. `state_envelopes` maps a browser global name to an
envelope source, and it is DATA for the same reason: that global is a handshake with a specific
bundle, so a hardcoded name locks the host to one bundle forever.

**And the VALUE says where it comes from, `{"from": "landing_offer", "key": "..."}` or
`{"from": "served_directory", "path": "/assets/..."}`.** Until 2026-09-09 the source was implicit
and there was exactly one, the landing-offer table, which is a closed set with a single member and
therefore reads as no set at all. That is how it survived: nothing looks like an enumeration until
someone needs a second member, and the tenant who needed one forked the whole server instead.
`ENVELOPE_SOURCES` now binds each `from` to a resolver, so adding a SOURCE is a row there and
adding an ENVELOPE is DATA. A bare string still means a landing offer, because live descriptions
carry that shorthand and it is normalized in one place so only one shape reaches a resolver. An
envelope naming a source nothing provides is served `unavailable` with a log line naming it, since
the bundle already renders `unavailable` as an absent card while a missing global is a
`ReferenceError` in someone's browser.

`served_directory` answers with the files a tenant already serves under one path, as URL paths,
sorted so the same directory is always the same page, files only, and empty on any failure because
it runs while BUILDING an answer. It knows nothing about what the files are for: a hero mosaic, a
logo wall, a photo strip and a font list are the same question asked by different tenants.

**The same rule covers IDENTITY, not just content**, and that half was violated for longer
because it fails quietly. `BITFIELD_PARTITION`, `BITFIELD_HOST_ENTRY_SCENE_HOSTS` and
`BITFIELD_APP_ENTRY_SCENE_HOSTS` all default to empty and none of them may name a tenant. Until
2026-09-05 they defaulted to one, and the cost was not a wrong page: an unconfigured host
became that tenant for routing, for the `partition_label` written onto its leads, and for the
canonical origin it published. A wrong page is reported in an hour and a wrong route is not.
**And the VARIABLE NAMES were the same violation, fixed 2026-09-05.** Six were `TENANT_`-prefixed,
so a second tenant's operator would configure variables named after the first. Every one reads a
`BITFIELD_` name now; the old names survive as legacy aliases in a single `TENANT-NAME-EXEMPT`
block, so a deploy carrying an old name keeps working and logs which name to rename. Delete a row
the day no deploy sets it. `BITFIELD_ISLAND_ASSET_DIR` (was `TENANT_SITE_DIR`) LOST its default
instead of inheriting it, because a default is one tenant's value compiled back in, and because
that particular default pointed at nothing: no Dockerfile in the set creates `/opt/tenant/site`.
Unset now serves nothing and says so once, rather than 404ing in silence.

Empty is now the default, so an unmatched role is a warning at boot and a test reads this
source and fails if any default in the `config` literal names one.

`BITFIELD_PUBLIC_ENTRY_STATIC_SITE_DIR` names a directory of hand-authored files this tenant serves
alongside the rendered pages, and `BITFIELD_PUBLIC_ENTRY_NOINDEX_HOSTS` names the hosts whose
answers carry `X-Robots-Tag: noindex` (a preview domain serving production bytes must not compete
with production in an index). Both default to empty, and for the site directory that IS the whole
of the on/off switch: a tenant with no authored site configures nothing and the route never matches.
No second boolean says so, because a capability whose dependency is injected and whose absence is an
early return is optional already.

The call sits one line above `shouldRenderPublicEntry` and the position is the design. That render
is a catch-all for a public host, so a call placed after it never runs; a call placed BEFORE the
specific routes, which is what the `tenant-fork` fork did, has to carry a hand-maintained
reserved-prefix list so a file cannot shadow a route, plus a regex of the tenant's own page names so
only known files are reachable. Between the two, neither list is needed: every specific route is
above and has already returned, and the reserved set the fork duplicated is the exclusion list
`shouldRenderPublicEntry` already owns. A tenant's files outrank the generic page render and never
a route.

## Tests

Each of these builds the generic server for its own test run, boots it against a dead engine, and asserts a visitor still gets a
page. They exist because an engine replaying its log for minutes after a deploy is the normal
case, not the exceptional one.

| Test | What it pins |
|---|---|
| `__tests__/app-shell-survives-a-dead-engine.test.mjs` | the app host serves its shell and the last good SCENE, across a restart |
| `__tests__/public-landing-page-renders-without-an-engine.test.mjs` | the public host serves a complete island PAGE, asserted as structure rather than as wording |
| `__tests__/kept-prices-survive-a-dead-engine.test.mjs` | kept PRICES reach the page, a half-priced or corrupt kept file is refused, and a missing one is a normal first boot |
| `__tests__/a-recovering-host-serves-only-its-own-archive.test.mjs` | a host asked for a route it never declared does not answer with another tenant's page. Red before `fallback_pages_file` existed and green after. **Neither older guard could see this**: the tenant-name suite reads `.mjs` under `processes/` and the archive was a `.json`, and the two-tenant suite asks each tenant for ITS OWN routes, so a leak appearing only on a path NEITHER tenant declared is invisible to a test that asks each tenant what it has |
| `__tests__/a-description-names-its-files-where-it-lives.test.mjs` | a description naming bare file names is served the files beside itself, NOT the same-named decoys in the directory the process was started in, and an absolute path is still passed through untouched |
| `__tests__/a-tenant-with-no-island-still-gets-a-page.test.mjs` | a description with no `island.bundle_url` is served its declared body at the root rather than an empty mount div at 200, and the same body on a non-root path |
| `__tests__/an-envelope-says-where-its-value-comes-from.test.mjs` | an `island.state_envelopes` value is `{from, key}` or `{from, path}` and `ENVELOPE_SOURCES` binds each `from` to a resolver, so a new SOURCE is a row there and a new ENVELOPE is DATA. Pins that a `served_directory` envelope arrives filled, sorted and files-only; that a file added to the directory appears with no description change; that the bare-string shorthand still resolves, because the live gardening description carries it; and that an envelope naming a source nothing provides is served `unavailable` with a log line naming it, never a missing `window.` global |
| `__tests__/a-tenants-authored-files-answer-where-no-route-did.test.mjs` | a tenant's authored files are served, clean URLs reach their `.html`, HEAD answers headers only, a no-index host says so and a normal one does not, a traversal is refused, and above all **a route still answers when a file shares its name** (the check that goes red if the call is ever moved ahead of the routes) |
| the landing test's second half | a host with NO description refuses with 503, names what is missing and both sources, and leaks no tenant name |
| `__tests__/one-binary-serves-two-tenants.test.mjs` | ONE process serves two hosts as two different tenants, neither leaking into the other, including the editorial body, the page-shell stylesheet and the thank-you page reached by an actual `POST /apply`; refuses a third host it was never described AND says which of the two causes it is; announces a malformed entry with its position rather than dropping it silently; and asserts no response header names a tenant |
| `__tests__/every-installed-package-set-description-renders.test.mjs` | the description each REAL set ships actually serves: its own title reaches its own page, its `fallback_body_file` and `shell_css_file` are on disk where it says and reach the page, and its advertised `noscript_route` answers 200 |
| `__tests__/the-generic-server-names-no-tenant.test.mjs` | no installed tenant's own words appear in any non-test `.mjs` under `processes/`, DISCOVERED rather than listed. **This does NOT duplicate the repo-wide rule `a-generic-package-source-may-not-name-a-tenant`, and deleting either loses something:** that rule ENUMERATES tenant words in DATA and covers every package; this one DERIVES them from whatever sets are installed here, including the names a tenant invents, so it catches a word nobody thought to list. Both exempt the same per-line `TENANT-NAME-EXEMPT` marker. Forbidden words are DERIVED from every set that ships a page description: its folder name, its declared `brand` and `title`, and the names it INVENTS (`landing_offers` keys, `island.state_envelopes` values). Matched on token boundaries, since `setHostWidth` contains `ethos` as a substring. One visible `TENANT-NAME-EXEMPT` block covers the legacy env aliases, and an unbalanced block is itself a failure because it would silence the rest of the file |
| `__tests__/hosted-public-app-backend.test.ts` | the descriptor-materializer backend contract below |
| `__tests__/two-accounts-never-share-a-runtime-instance.test.mjs` | WHICH UPSTREAM answers, for every one of the five outcomes, because a leak here does not look like an error: it looks like a working page with somebody else's conversation on it. Two accounts never share one; the same account returns to its own; a principal CLAIMED in the request is ignored; a directory that cannot answer is refused rather than signed out; a starter that opened nothing does not fall back; a workspace may not resolve to the directory |
| `__tests__/one-account-gets-one-workspace-it-can-reach.test.mjs` | the two silent failures beneath that: a colliding workspace name (proven over case, whitespace, path separators, the encoding escape itself, both Unicode spellings of one word, and lengths either side of the digest threshold) and a ready file read optimistically (a booting shell, a half-written file, a socket-only transport, and a non-HTTP url each stay unreachable rather than becoming an upstream) |

**The four generic suites and that last one ask different questions, and both are needed.** The
generic four serve a tenant that is deliberately NOT the product, because a pass against
production copy could come from accidental agreement. That leaves a hole its own shape: a typo in
a live description, or a body file a deploy moved, keeps all four green and answers 503 to a
visitor. The per-set suite closes it by rendering what each installed set actually ships, and it
asserts NO copy: the description supplies its own expected values, so an editorial change can
never be a test failure. Asserting the live headline would teach people to edit tests to ship
words.

Every spawning suite uses `__tests__/built-entry-server.mjs`. That helper compiles the generic
source for that test process and passes the resulting file directly to the suite. It never scans
package sets, deployment outputs, installed projections, or a shared build directory.

Both suites FOLLOW the `noscript_route` rather than only finding a `<noscript>` in the markup,
reading the route out of the description instead of hardcoding it. A link-exists check cannot
fail while its destination is broken, and that destination WAS broken: the moment the editorial
body became per-tenant, `/classic` answered 503 for both test tenants while every check stayed
green.

The landing suite proves the tenant's `chrome_css_file` is read and inlined, through an archived
article route. That works with no engine because `renderRecoveryPublicEntry` serves from the
baked archive. **The test's `index.html` fixture must carry the entry root markers** or
`injectRoot` throws, the article path catches the throw, and the route silently serves the
editorial body instead, which looks exactly like the article path not matching.

The landing suite also proves the tenant's `fallback_body_file` CONTENT reaches the page, using
a marker from `__tests__/fallback-body-for-tests.html` that no other source contains. Emptying
that fixture was tried: the server answered **200 with every other check green**, and only those
two markers caught it. Keep them, and keep the fixture's copy unlike the live site's.

They supply their own page description, `__tests__/page-description-for-tests.json`, whose
values are deliberately NOT the live site's. That is the point: the suites prove the shells are
generic by rendering **a tenant that is not the product**, so a pass cannot come from accidental
agreement with production copy.

## Backend Contract

- Package-specific labels, fields, routes, process names, and metadata live in
  `things-to-store-and-run.json` descriptor records.
- `do-work/request-publish-live-site.ts` is a generic descriptor materializer:
  it resolves an action descriptor, workflow definition, process templates,
  argv/env mapping rules, and invokes the workflow owner target with opaque
  payload bytes.
- `read-data/described-file-at.mjs` answers WHERE a file named by a page
  description actually is, for the server answering a request and the suite
  checking a set. An absolute path is passed through, so
  a deploy that means one gets it; anything else is relative to the folder the
  description was deployed in, which is the folder a container `COPY` puts its
  files in. Every `_file` key is covered by the suffix rather than by a list, so
  a fifth kind of described file is resolved the day it is named. Both installed
  descriptions used to name absolute paths under one person's home directory,
  which resolves on exactly one computer and fails quietly everywhere else: a
  missing stylesheet is one log line on a page that still answers 200.
- `read-data/package-store-metadata.ts` materializes metadata from
  `operational-record.metadata-descriptor.v1`; the product title, URL,
  description, and image values are data.
- `read-data/operational-record-projection.ts` folds generic field, view,
  action, rule, and relationship descriptors. It does not define a
  hosted-publication backend class.
- `read-data/named-price-option.mjs` answers which option of a linked offer a
  funnel step sells: a named `price_option_ref` wins, a sole option needs no
  name, and everything else is `null` so the caller falls back to the
  `display_amount_cents` the funnel author wrote. A name that matches nothing
  returns `null` rather than degrading into position, which is the whole point:
  position is not authored, and position zero is typically a $0 trial. It is
  package-local on purpose, not a shared helper with the sibling packages, per
  the convergence verdict; what is shared is the DATA vocabulary. It sits here
  rather than in the entry server because that file exports nothing, so while
  the rule lived there no suite could import the expression that decides which
  price a funnel step charges.

## Proof

`selected-experience` graph records may declare `browser_import_bindings` as
`{ specifier, path }` pairs. The owner-only resolver passes those canonical
selection records to the materializer; it composes only bindings whose exact
projection path belongs to the selected closure and rejects duplicate,
ambiguous, or missing targets. Browser import resolution never inspects source
text or package-manager layout.

Run focused backend proof from `bitfield-packages`:

```bash
npx vitest run --config ./vitest.config.ts packages/hosted-public-app/__tests__/hosted-public-app-backend.test.ts
```

Live package implementation activation uses the scoped package-delta owner:

```bash
BITFIELD_SHELL_URL=<carrier-url> \
node bitfield-runtime-kit/references/background-runner-shell/scripts/apply-package-delta-live.mjs \
  --package-set-folder <runtime-package-set-folder> \
  --partition <running-partition> \
  --package hosted-public-app
```

The 2026-06-21 backend implementation proof wrote 50 package records, 15
stored-byte records, rebuilt `package::hosted-public-app::entry-bytes::package-store-metadata`,
through the retired aggregate commit path. That historical target is not an
activation instruction.
# Hosted-public publication deployment contract

The selected-experience publication owner mounts the selected bytes and runs the package-owned deployment profile through `compute.process_sequence`. The deploy step runs `processes/run-provider-deploy.mjs` in that contained workspace. Package-set DATA supplies a bounded profile name and values such as application name; it cannot supply a command, arguments, environment names, result parser, or working directory. The wrapper invokes the profile's pinned CLI and writes exactly one
`deployment-result.json` result: `{ "schema": "publication-deployment-result/v1", "share_url": "https://…/" }`.
`prepare-publication-records.mjs` is the only consumer of that result; CLI stdout
is never treated as the published route.

## Seller publication result

`requestSellerPublication()` returns the Workflow-owned publication result. For
an interactive hosted publication it contains `share_url` together with the
exact `publication_request_ref`, `publication_request_key`, and `intent_ref`
created by normalization. The seller surface renders the share link; the
identities are retained by the operator/readback boundary so the request,
intent, closure, offer, carrier, route, and Workflow result can be exact-read.
