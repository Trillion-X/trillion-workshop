# bitfield-package-store-catalog iOS JSCore

This folder owns the native iOS screen-command adapter for the catalog package.

- `mount-catalog-jscore.js` consumes the same
  `generic.record_action_projection.v1` bytes emitted by
  `read-data/read-record-projections.ts`.
- It emits `native.view.snapshot.replace` / `native.view.snapshot.dispose` and
  sealed `runtime.target.invoke` action payloads. It does not import React, use
  DOM APIs, or execute owner behavior locally.
- Device differences are native snapshot layout only. Labels, visible blocks,
  tones, actions, queued intents, and resolved intents remain projection data.

## Proof

```bash
cd ~/dev/bitfield-packages
node --test packages/bitfield-package-store-catalog/__tests__/ios-jscore.test.mjs
```
