# Bitfield Package Store Browse Surface

Public Package Store surface for browsing package and bundle rows.

## Public-language boundary

Internal catalog data can carry platform terms such as `recipe`, `workflow`,
or `slot` when those are data identities. The browse surface must translate
them before rendering public UI:

- `recipe` renders as `Bundle`.
- `workflow` renders as `Automation`.
- `slot` renders as `Capability`.

The package keeps that translation in `read-data/read-catalog-view.ts`, not in
the shared runtime and not in the shell.

## Public install boundary

The selected-package primary action installs package files into an explicit
destination package set through the selected catalog row's `install.target`.
Action-capability records can authorize `action:store-install`, but they do not
override the row target. This keeps stale wrapper rows such as
`bitfield-package-store.request-accept-package-files` from making the button
call a target the running owner does not expose. The browse surface does not
scan package-set folders to discover destinations.

Catalog rows carry package-file pointer object keys. When no local owner target
is supplied, the primary action downloads a `.bitfield-package` handoff file for
Bitfield to open locally:

`<base_url>/objects-named-by-hex-encoded-object-key-text/<hex(object-key)>`

Do not call the dead `package-sets.list-local` target. Destination choices come
from the package-owned `install-destinations` input when a local owner publishes
one. When no explicit destination is selected, the request omits
`target_package_set` and the actual install target resolves the active local
owner.

## Generic Projection Contract

The browse reader accepts both the legacy catalog snapshot and
`generic.record_action_projection.v1`. The catalog package owns projection
definitions; this package consumes the projection and arranges it for browser
and JSCore consumers. The React surface no longer carries hardcoded fallback
install target constants.

The anonymous discovery home also consumes
`CatalogDiscoveryView.replacement_catalog`. It renders the founder's
software job, the data-owned replacement claim, and resolved `CatalogCardView`
package pieces. Selecting a piece uses the existing detail path; the
composition CTA reuses the existing search path. Missing identities are
reported by the reader and never replaced with fabricated cards.

## Package Store Reviews Boundary

`things-to-store-and-run.json` declares
`package::bitfield-package-store-browse-surface::input::package-store-reviews-summary`.
That input points at the finished reader output
`package::package-store-reviews::reader-output::browse-summary`. Browse may
display or arrange that finished output; it does not read review source records,
fold rating math, decide report visibility, or import the reviews owner action
and projection internals.

Proof:

```bash
node --test packages/bitfield-package-store-browse-surface/__tests__/generic-projection-consumption.test.mjs
npx vitest run --config ./vitest.config.ts packages/bitfield-package-store-browse-surface/show/BitfieldPackageStoreBrowseSurface.test.tsx
npx vitest run --config ./vitest.config.ts packages/package-store-reviews/tests/consumer-boundary.test.ts
```
