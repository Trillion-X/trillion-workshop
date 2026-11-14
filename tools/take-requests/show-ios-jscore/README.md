# request-intake iOS JSCore

This folder owns the browserless JavaScriptCore realization for the
`request-intake` package.

## Contract

- `mount-request-intake-jscore.js` consumes the package-owned
  `RequestIntakeSurfaceData` screen model produced by
  `read-data/request-intake-projection.ts`.
- The mount emits sealed `native.view.snapshot.replace` operations with a
  one-task-per-screen navigation stack.
- Actions are sent through `runtime.target.invoke` to
  `package::request-intake::target::request-intake-change`; owner routing stays
  in `do-work/request-intake-actions.ts`.
- The file imports no React, DOM, browser API, downstream owner package, or
  device-specific backend.

## Proof

```bash
node --experimental-transform-types packages/request-intake/__tests__/request-intake-jscore.test.mjs
```

The proof generates the screen model through the TypeScript projection, mounts it
in a JavaScriptCore-compatible VM harness, verifies the state/navigation matrix,
and checks that JSCore action payloads execute through the same package target
contract as the browser path.
