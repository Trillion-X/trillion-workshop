# tools/bridge-a-sandboxed-app-to-its-data/

Runs an app an AI built in a sandboxed frame (scripts only: no same origin, no connections, no forms, no popups) and
gives it its data through one nonce-bound message port: named, versioned, schema-validated requests whose paths and
methods the host fixes, idempotent typed resource effects, media by one-file lease, a cap on pending requests, and the
person's look as bounded attributes and custom properties. Moved here byte for byte from Trillion-X/trillion
(`moved-from.json` names each file's source path, commit and identity). It is a library the web client imports
(`part.json` `imported_by`), not a row the engine runs.

## Files

| File | Purpose |
|------|---------|
| `parts/ui/show/isolated-module-surface/module-surface-document.mjs` | `moduleSurfaceDocument`: the sandboxed document (CSP, import map, the frame's end of the port), `checkedLook`, `MOST_PENDING_REQUESTS`. |
| `parts/ui/show/isolated-module-surface/module-surface-requests.mjs`, `sandboxed-screen-routes.json` | Request declarations validated before admission, fixed bindings, retry only for GET, scope keys, media identities; the shipped allowed requests are DATA. |
| `parts/ui/show/isolated-module-surface/IsolatedModuleSurface.tsx`, `resource-task-outcome.mjs` | The host's end: the frame, the port, update accepted/refused, media leases. |
| `parts/ui/show/isolated-module-surface/README.md` | The part's own notes. |
| `test/isolated-module-surface.test.mjs` | The original test and assertions, less the ones that read the old app's own screens (`src/workspace/tool-screen.tsx`, `lazy-screen.ts`) and their Worker routes, which stay in Trillion. |
| `moved-from.json` | Where each file came from. |

## How to run the tests

```
node --test 'tools/bridge-a-sandboxed-app-to-its-data/test/*.test.mjs'
```
