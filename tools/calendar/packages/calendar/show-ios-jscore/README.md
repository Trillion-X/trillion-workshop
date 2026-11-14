# Calendar Native JSCore Surface

This folder contains the JavaScriptCore screen-command surface for `calendar`.
It consumes the same Calendar interval/action data shape used by browser and
desktop surfaces, then emits generic native snapshot operations.

## Files

| File | Purpose |
| --- | --- |
| `calendar-jscore-renderer.js` | Pure Calendar model-to-native-snapshot renderer. |
| `mount-calendar-jscore.js` | JSCore mount that reads the `time-blocks` package input and sends `native.view.snapshot.replace` / `native.view.snapshot.dispose`. |
| `__tests__/calendar-jscore-renderer.test.js` | VM-based JSCore contract proof for render states, package input reads, sealed native target invocations, and browser-global exclusion. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
| --- | --- | --- |
| `CalendarJscoreRenderer.normalizeModel` | `(value) -> { title, dateLabel, timezone, accounts, blocks, actions, issues, state }` | Normalizes the same Calendar feed object read by the browser surface without importing React or provider helpers. |
| `CalendarJscoreRenderer.renderCalendarNativeSnapshot` | `(value, lifecycleKey) -> { schema: "bitfield.native.view.snapshot", lifecycle_key, summary, root }` | Emits the sealed native snapshot consumed by the iOS screen host. |
| `CalendarJscoreRenderer.actionPress` | `(descriptor, extraInput) -> { operation: "runtime.target.invoke", payload: { target, payload } }` | Converts owner-action descriptors into the exact native target-invoke envelope decoded by the iOS shell. |
| `bitfieldMount` / `mount` | `(record, mount) -> { dispose() }` | Reads `package.input.read` for `time-blocks`, renders a native snapshot, and disposes with `native.view.snapshot.dispose`. |

## Invariants

- No browser UI globals, WebView, or platform UI framework imports.
- No source-owner branches; Calendar receives finished interval/action data.
- Owner actions remain descriptors carried in data and are forwarded through the generic target invocation shape: the native action operation is `runtime.target.invoke`, and its payload is `{ target, payload }`.
- The mount reads only the package-owned `time-blocks` input. It does not read service/account owner tables or start provider refresh work.

## Dependencies

**Depends on:** `package.input.read` for Calendar inputs, native snapshot
operations, and target invocation data on action rows.

**Depended on by:** `things-to-store-and-run.json` native screen-command entry
and stored JSCore artifact records.
