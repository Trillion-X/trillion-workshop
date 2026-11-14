# show-ios-jscore

JavaScriptCore realization of the Local Files surface for the package-owned Apple app — a directory tree browser rendered as generic native screen nodes.

## Files

| File | Purpose |
| --- | --- |
| `mount-local-files-jscore.js` | JSCore mount: lists directories through the generic `local.files.list-directory` target (via `runtime.target.invoke`), renders the file tree as native snapshot nodes, and re-renders on navigation. |

## Invariants

- Local Files owns file-list projection and emits generic native snapshot operations; Screen Arrangement only mounts this package artifact.
- Directory listing stays inside the app-opened Bitfield folder — path safety is enforced by the shell's generic target, not by this surface.

## Dependencies

**Depends on:** `runtime.target.invoke` → `local.files.list-directory`, shell operations `native.view.snapshot.replace` / `native.view.snapshot.dispose`.

**Depended on by:** the contract record `package::local-files::native-screen-command-entry` and the `built-show-ios-jscore-mount-local-files-jscore` stored-bytes build.
