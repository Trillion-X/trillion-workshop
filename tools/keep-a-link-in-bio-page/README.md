# Keep a link in bio page

The source-first link-page library preserves page edits, one opaque public code, pending-code recovery, HTTPS-only
opens, publication filtering, attribution tags, private totals and recent counts, and the original name-claim lifecycle.
Its content and settings are supplied from the person's installed rows, rather than a new content file.

The page is values (W3.2a). The page record and its visit and open rows are the person's own rows in their own store:
workflow:keep-a-link-in-bio-page keeps and counts them. `makeLinkPage({ page, counts, posts, settings, origin, names, namesWords,
now, random })` takes the stored page and its count rows as values, and returns `read()`, `visit(place)` and `open(item, place)`,
which answer the page, the tagged address and the count row to keep, and `change(input)`, which answers `{ page, steps }`.
The host runs `steps` in order: a `keep` step writes the page value; a `kv_put` step makes the public code point at the
store, after the `keep` that holds the pending code; a `kv_delete` step follows the `keep` that turns the page off.

The unique-name authority (`names.claim/point/release`) is an injected host facility, called from `change`. `countsOf`,
`shownPosts`, `pageAddresses`, `placeOf`, `isLinkPageCode` and `taggedAddress` are pure. `handleLinkPageRequest(owner,
request, { failureOf })` takes the shared failure classifier from the host; retryable failures escape unchanged.

Removed in W3.2a: `createLinkPageTable` (the count tables are the recipe's rows), `linkPageOverDoor` (the records door is the
host's own, and the page is now values), and the `sql` and `eeaf` facilities. The port contract ports/link-page.json still
records the earlier door adaptation; its owner must update it.

Run `node --test tools/keep-a-link-in-bio-page/test/link-page.test.mjs`.
