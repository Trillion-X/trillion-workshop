# tools/rank-records-for-review/

Puts a person's records in the order they should review them, with the fields they chose on each row and where they already stand on it (accepted, passed, partly, or nothing yet). Every word about a domain is in the descriptor the person gives; the code knows records, paths, ranks and refs only.

- The ranking over the person's own rows is the recipe `workflow:rank-records-for-review` (`tools/workflows/recipes/rank-records-for-review.json`): a store query in the person's own store, ordered by rank then by record ref.
- The fold in `read-data/rank-records-for-review.mjs` and `read-data/ranked-record-review-projection.js` is the same rule as a pure function. It stays for the phone (`ios-jscore/`) and for the accept-or-pass step, which computes one row's actions on the values it is given.
- `do-work/accept-or-pass.mjs` (`tool:accept-or-pass-on-a-ranked-record`) turns an accept or pass into the request `do-work/stand-request.mjs` builds, and the keeper is the recipe `workflow:keep-where-the-person-stands-on-a-record`. It writes nothing.

Removed in the landing commit: the ranking command (its input is the same fold, now the recipe), the old engine's owner-action and refresh transports (`owner-action-request.js`, `refresh-request-descriptor.js`, the runtime manifest `things-to-store-and-run.json`), which belonged to the retired runtime.

The `data/ranked-review-descriptors.json` file still names the old workflow definition ids; it is DATA and is not changed here.
