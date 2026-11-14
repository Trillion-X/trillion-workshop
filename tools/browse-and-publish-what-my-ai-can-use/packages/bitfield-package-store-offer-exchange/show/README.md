# show

Shared screen descriptor contract for `bitfield-package-store-offer-exchange`.

`offer-setup-surface-descriptor.ts` is the browser/iOS boundary: renderers may
dispatch only on `SectionKind`, which is a closed set of rendering shapes.
Package states, labels, tones, checklist rows, action labels, disabled reasons,
and proof rows are data inside the descriptor.

`map-record-exchange-projection.ts` maps the package's generic
`RecordExchangeProjection` into that descriptor. It does not import React and it
does not enumerate package-store outcome states; it copies descriptor/fact labels
and copies descriptor-owned rule state labels/tones into checklist rows.

## Proof

```bash
cd dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/bitfield-package-store-offer-exchange/show-ios-jscore/mount-offer-setup-jscore.test.ts
```
