# iOS JSCore Surface Contract

The JSCore entry receives the same folded scheduled-action projection rows as
the browser surface and returns a JSON-only mobile queue/detail model plus
generic action invocation payloads. It also exposes the sealed
`native.view.snapshot.replace` / `native.view.snapshot.dispose` bridge used by
the iOS screen host.

It does not import React, DOM APIs, browser storage, provider clients, adjacent
package source, or another backend schema. Offline and online behavior are
driven by log-owned descriptors and action receipts.

## Proof

```bash
node ~/dev/bitfield-packages/packages/timed-action/__tests__/timed-action-ios-jscore.test.mjs
```

The proof checks JSON serializability, shared projection/action descriptor
shape, translated mobile sections, and sealed native snapshot operations.
