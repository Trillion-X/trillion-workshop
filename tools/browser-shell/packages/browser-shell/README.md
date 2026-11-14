# Browser Shell

Package-owned browser shell root component.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Publishes the browser-shell package entry and root component records. |
| `show/` | Browser shell entry source. |
| `do-work/let-another-server-reach-a-running-app.mjs` | Lets any existing web server host Bitfield packages: answers `/boot`, `/target/…`, `/cas/…` and the `/ws` socket on the host's own origin by forwarding them to a Bitfield app open on this computer, found through that app's published ready file. While that app is not open, `/boot` answers 503 in the runtime's `recovering` shape (`retry_after_milliseconds: BOOT_RETRY_AFTER_MILLISECONDS`), so the page waits and connects when it opens; other runtime paths answer a plain 503 `APP_NOT_OPEN`. |
| `do-work/let-another-server-reach-a-running-app.test.mjs` | A closed app: `/boot` is recovering, a target is not open, a host path is untouched. |
| `show/put-host-screens-beside-package-screens.mjs` | Wraps the page's on-screen runner so entries under the host's own package name are mounted by the host (its own screens in tabs and splits) and every other entry goes to the runtime. |
| `do-work/give-each-package-its-own-read-scope.mjs` | Vite plugin for such a host page: package code importing `@bitfield/runtime-kit/react` gets a read scope built from its own package's declared inputs, the same rule the package entry builder applies. |

## Hosting packages inside another app

A page outside Bitfield runs packages as plugins in three steps:

1. Its server calls `createRunningAppReach({appId})` and routes `handleRequest` / `handleUpgrade` to it before its own routes.
2. Its dev server adds `givePackagesTheirOwnReadScope({packagesRoot, runtimeKitRoot})`.
3. The page imports `installBitfieldBootHooks` from the runtime's `shell-runtime.js` and sets `globalThis.__THINGS_TO_PUT_ON_SCREEN__` from `things-to-put-on-screen.js`, then calls any package's `mount({el, props})`.
4. To put its own screens in Bitfield tabs, the host publishes placeable-surface records naming its own package (each needs `kind: "placeable-surface"`, `material_target`, `package_entry`) and wraps the runner with `putHostScreensBesidePackageScreens`.

## Key Functions

| Function | Shape | Role |
|---|---|---|
| `createRunningAppReach` | `({appId, home?}) => {handleRequest(req,res,pathname), handleUpgrade(req,socket,head,pathname)}` | Forwards the four runtime paths; returns false for every other path. |
| `currentSocketFor` | `(appId, home?) => string` | Reads the running app's forwarding socket fresh each call; throws in words when the app is not open. |
| `isRuntimePath` | `(pathname) => boolean` | The four paths a runtime page uses. |
| `putHostScreensBesidePackageScreens` | `(runner, {packageName, mountScreen(entry, element, props) => cleanup}) => runner` | Host screens as equals of package screens. |
| `sendToRunningApp` | `({appId, target, payload}) => Promise<reply>` | One target request from the host's server, with the app's current command-list basis. |
| `givePackagesTheirOwnReadScope` | `({packagesRoot, runtimeKitRoot}) => VitePlugin` | Per-package read scopes from each manifest. |

## Dependencies

**Depends on:** each package's `things-to-store-and-run.json`; the runtime kit (`@bitfield/runtime-kit` source); the running app's `this-bitfield-shell-is-ready.json`.
**Depended on by:** `dev/media-workspace` (server.mjs, vite.config.mjs).

## Rules

- Root executable source is declared with `source_bytes.address_label` pointing at the live package entry-byte record.
- Integrity metadata may describe built bytes, but it is not an active root UI loading path.
- This package does not decide package discovery, sidebar catalog contents, or screen-arrangement placement.
