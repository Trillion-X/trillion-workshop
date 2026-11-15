# Keep a link in bio page

The source-first link-page library preserves page edits, one opaque public code, pending-code recovery, HTTPS-only
opens, publication filtering, attribution tags, private totals and recent counts, and the original name-claim lifecycle.
Its content and settings are supplied from the person's installed rows, rather than a new content file.

`makeLinkPage` keeps the original host interfaces: `sql.exec(query, ...binds).toArray()`, synchronous `eeaf.read(id)`,
awaitable `eeaf.write(rows)`, `posts()`, the public-code `kv.put/delete`, `storeId`, `origin()`, and optional unique-name
authority `names.claim/point/release`. Supply `namesWords` from the name owner's words. `createLinkPageTable(sql)` is
called once when that host opens the count tables. Changes await `commit(change, { operation })` and record writes;
the pending code is durable before a public pointer is made.

`linkPageOverDoor({ door, ...host })` replaces the record interface with the existing selected-account records door.
It reads exactly the configured record and makes conditional writes; a stale snapshot refuses instead of overwriting
another request. Construct a fresh owner per serialized request so public reads see the current on/off state.

`handleLinkPageRequest(owner, request, { failureOf })` takes the shared failure classifier from the host. Retryable
failures escape unchanged. The public visitor answer excludes counts and destinations; opens resolve listed ids only.

The count SQL, public lookup and cross-account name authority remain explicit host seams. This library neither supplies
those engines nor installs public routes. Their production wiring is unverified; the tests exercise real SQLite plus
in-memory account/index/name hosts and the conditional records-door contract.

Run `node --test tools/keep-a-link-in-bio-page/test/link-page.test.mjs`.
