# show-ios-jscore

Browserless iOS JavaScriptCore realization for
`bitfield-package-store-offer-exchange`.

## Contract

- `mount-offer-setup-jscore.js` consumes the same
  `OfferSetupSurfaceDescriptor` exported by `show/`.
- It emits sealed `native.view.snapshot.replace` and
  `native.view.snapshot.dispose` operations for the native iOS renderer.
- It dispatches user controls as sealed `record-exchange.action.request`
  payloads. Owner-action intent construction remains in `do-work/`; JSCore does
  not execute workflow, signing, account, package file, process, or credential
  work.
- It imports no React, DOM, browser storage, fetch, or platform backend APIs.
- It only dispatches on `section.kind`, the Physics-closed rendering category.
- It does not author visible section labels, action fallback copy, proof fallback
  copy, or rule state labels. Those values arrive through the shared descriptor.

## Proof

```bash
cd ~/dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/bitfield-package-store-offer-exchange/show-ios-jscore/mount-offer-setup-jscore.test.ts
```

The proof derives the descriptor from the package's descriptor/fact fixtures,
mounts the JSCore file in a VM harness, verifies sealed native snapshot output,
checks action requests against the shared owner-action intent contract, and
scans the JSCore source for forbidden renderer meaning.
