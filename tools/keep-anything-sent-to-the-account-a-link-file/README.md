# tools/keep-anything-sent-to-the-account-a-link-file/

Keep anything sent to the service, a link, file or words, safely at the edge when the person's store is busy, then deliver it with its status.

This folder has no row yet. Its old the service files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Built, not wired

`read-data/share-inbox-rules.mjs` (with `read-data/share-inbox-rules.json`) holds the decisions of the share inbox ported from the earlier code base `src/share-inbox.mjs` at b6ae0ebf815f: what a store's answer means for a kept share, when it resumes, what it keeps, its size limit, its give-up count and its words. It holds no storage. Nothing here is packed or wired; the storage that holds what waits is an owner ruling, and the rules are tested by `test/share-inbox-rules.test.mjs`.
