# browsing-surface-provider

Log-delivered realm "brain" that gives the `web-frame` package a cross-origin browsing surface by addressing one browser runtime through `compute.process_session`, speaking CDP, and painting captured frames to a canvas.

## Why this exists

An `<iframe>` cannot display many sites because `X-Frame-Options` and CSP are enforced by the browser engine. This provider asks the native process-session owner to start a browser, speaks Chrome DevTools Protocol to it from the realm WebSocket, paints `Page.captureScreenshot` frames to a `<canvas>`, and forwards mouse, keyboard, and wheel input as CDP `Input` events. The realm coordinates; the native owner performs process and filesystem work.

The package request is portable: it names a registered runtime alias (`browser`) and a contained relative profile directory, never a machine executable or profile path. The default realization is `headless-new`, because macOS clamps supposedly off-screen headful windows back onto a display. The provider applies the same general launch configuration to every site; it has no per-site branch.

**Current source status:** the provider request and focused unit test are migrated, but the end-to-end browser capability is not production-ready. The selected Studio app-open handle now binds `browser` to an immutable raw headless-Chromium OCI runtime; that alias is not the separate `agent-browser` CLI command used by the bounded agent-tool workflow. `compute.process_session` remains fail-closed, Darwin descendant containment is unresolved, and a relative profile directory inside an ephemeral process root is not durable persistence. Those are owner/runtime gaps; this README does not present them as completed provider behavior.

`web-frame` consumes this through the generic contract it already defines (`globalThis.__BITFIELD_BROWSING_SURFACE__`) and is **unchanged** by this package.

## The package declares what it delivers

Since 2026-09-09 this package has a `things-to-store-and-run.json`, and it is delivered like every other
package: `make-packages-match-their-source` takes the engine and the partition as arguments and ships a
scoped delta of the rows below to any app. Nothing in this folder names a host, a port, a partition or an
app. The rows:

- `package::browsing-surface-provider::entry::provider`, a `bitfield-package-entry` over `provider.mjs`
  (no `export_name`, so the generated shim exports `default as mount`), backed by the `stored_bytes`
  `entry-bytes-provider` that `make-packages-match-their-source/do-work/build-entry-bytes-for-chosen-packages.mjs`
  builds into `built-stored-bytes/` with its source-closure receipt. The bytes land at
  `package::browsing-surface-provider::entry-bytes::provider` in whichever app the package is delivered to.
- Two `package-record-contract` rows for the wire schemas `group` and `markup-scene-decoder` dispatch on,
  `browsing-surface-provider.spatial-source-capture.request` and `.response`.
- A `package-checks-descriptor` naming the three `*.test.mjs` files, so `run-the-declared-checks-for-chosen-packages` reaches them.
- A `reaches-past-the-engine` row for `network`: the CDP WebSocket to the browser process the engine started
  for this package, at the address the process-session endpoint returns. That declaration is what lets the
  entry-bytes builder compile `provider.mjs` at all; without it the build refuses at the reach border.

**History, kept because the next reader will hit its residue.** Until that day this section said the folder was
"source / proposal material", that the live module was bytes in partition `bitfield-studio` mounted by a scene node
`scene-root:bitfield-studio-browsing-provider`, and it told a person to run a kit script pointed at
`http://127.0.0.1:3012`. That scene node was a hand-written log record no manifest ever declared (grep for
`scene-root:` over every manifest returns nothing), Studio is retired, and the script is the hand-run delivery
the parent plan `2026-09-09-a-package-declares-what-it-delivers` removed from six packages. Also removed the
same day: a `fetch` to a bring-up beacon at a frozen loopback port on every diagnostic line, stamped with a
hand-typed version marker. Diagnostics are the console line only now.

**The wall that remains, exactly.** Delivering the package puts the bytes in the app. Nothing mounts them,
because the only thing that ever ran this module in a realm was that Studio scene node. The affordance that
closes it is a generic "run this package entry in the realm on app open" record kind owned by the shell, which
is the same missing owner `web-frame`'s README calls "a generic runtime capability, not a Web Frame package
fork". It is outside this package. Until it exists, `web-frame` finds no `__BITFIELD_BROWSING_SURFACE__` and
renders its blocked-recovery state, which is the honest behaviour it already documents.

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | The package boundary: the `provider` entry + its built `stored_bytes`, the two capture-schema contracts, the checks descriptor, and the `network` reach declaration. |
| `provider.mjs` | The provider module (default export `putOnScreen`). Bundled by the entry-bytes builder into `built-stored-bytes/entry-bytes-provider` and delivered as the `provider` entry. |
| `built-stored-bytes/` | The built entry bundle and its `.source-closure.json` receipt. Generated; rebuilt by the builder, never edited. |
| `.bitfield-entry-scope/provider/` | The generated shim and runtime-kit scope for the entry. Generated from the manifest; do not edit. |
| `provider.test.mjs` | Node unit test: portable session request + retired-field rejection + custom-element registration + multi-surface independence + watchdog-lift bridge + exact capture routing (10 checks). Run `node --test packages/browsing-surface-provider/provider.test.mjs` from the Bitfield Packages root. |
| `dom-snapshot-contract.mjs` | Bounded CDP capture leaf: DOM/layout/computed CSS, matched rules, resources, and a PNG from one already-owned target session. |
| `dom-snapshot-contract.test.mjs` | Hostile focused tests for request bounds, same-session capture, missing resources, detached nodes, and malformed CDP replies. |
| `terminal-page-proof.mjs` | Pure fail-closed decoder for a terminal browser page-session proof: terminal state, exact session identity, exact allowed origin, bounded terminal output, and bounded correlated page evidence. It performs no I/O and never converts start acknowledgement into success. |
| `terminal-page-proof.test.mjs` | Hostile focused tests for running/session-started states, foreign sessions, wrong origins, malformed output/evidence, and bounds. Run `node --test packages/browsing-surface-provider/terminal-page-proof.test.mjs` from the Bitfield Packages root. |
| `README.md` | This file. |

## Key Types / Functions (`provider.mjs`)

| Export / Type | Signature / Shape | Role |
|---------------|-------------------|------|
| `default putOnScreen(context)` | `({el,screenPlace,...}) => cleanup` | Shell entry. Hides own node, installs `__BITFIELD_BROWSING_SURFACE__`, defines the custom element. Boots no browser at mount. Cleanup requests surface disposal, `Browser.close`, and `end_session`; native descendant cleanup remains an owner proof obligation. |
| `CONFIG` | `{browserRuntimeAlias, browserProfileDirectory, realness, realnessModes, spatialCapturePolicy, offscreen, screencastQuality, ...}` | Society-as-config; overridable via `globalThis.__BITFIELD_BROWSING_CONFIG__`. It contains no native executable or absolute profile path. Every capture default/bound lives in `spatialCapturePolicy`; the capture leaf owns no capacity numbers. |
| `CONFIG.realnessModes` | `{ 'headful-offscreen': (cfg)=>string[], 'headless-new': ()=>string[] }` | Realness as a DATA table (enum-dissolution): `_boot` does a TABLE LOOKUP, never a string branch. Add a mode = one data entry, zero code change. |
| `__BITFIELD_BROWSING_SURFACE__` | `{elementTag:'bitfield-browsing-surface', navigation:{back,forward,reload}, capture, isolation, events}` | The generic contract `web-frame` reads; `web-frame` does `React.createElement(elementTag, {src,onLoad,onError,'surface-key':...})`. |
| `__BITFIELD_BROWSING_SURFACE__.capture.spatialSource(request)` | `spatial-source-capture.request -> spatial-source-capture.response` | Captures the explicitly addressed existing surface (or the active surface when no key is supplied); never launches a second browser. |
| `SurfacePage.publishTaskSurfaceIsolation(request, surfaceKey)` | internal trusted-owner call returning `{observation,binding}` | Re-observes the exact current CDP target and publishes it through the native process-session capability held only in this mounted realm. It is deliberately absent from the public realm API until a trusted task/bootstrap challenge owner exists; caller-authored task identity cannot spend the capability. |
| `SurfacePage.captureSpatialSource(request)` | `Promise<CaptureResponse>` | Serializes capture calls on the page's existing CDP session and reports counts only. |
| `<bitfield-browsing-surface>` | custom element, attrs `src`, `surface-key` | Thin VIEW: owns a `<canvas>` + input forwarding. Acquires a surface by `surface-key`; never owns a Chrome process. |
| `browserConnection` | `{acquire(),release(),forceDispose(),_boot(),_dispose()}` | Module-level ref-counted owner of the ONE Chrome process + one CDP socket. Grace-period dispose survives React remount churn; `forceDispose()` hard-releases on realm teardown. |
| `surfacePool` | `Map<surfaceKey, {page,views,disposeTimer}>` | N surface keys → N isolated `SurfacePage`s (N windows/targets in the one browser). Identity-scoped nav events: a load on pane B never moves pane A. |
| `SurfacePage` | `start/navigate/back/forward/reload/mouse/wheel/key/resize/markLost/dispose` | One page target (`Target.createTarget{newWindow:true}`) + screencast + background poll + input. `dispose()` = `Target.closeTarget` (NOT `Browser.close`). |
| `Cdp` | `open/send(method,params,sessionId)/eventSink/close` | CDP client over the realm WebSocket, flatten mode (one socket, per-target session routing). |

## Invariants

- **One general browser policy.** The provider has no site-name or origin-specific behavior. It does use `--disable-blink-features=AutomationControlled` and `Emulation.setUserAgentOverride` to remove automation/headless markers from the presented browser identity; those exact mechanisms are explicit here rather than described as absent.
- **Portable runtime selection.** `argv[0]` is the direct alias `browser`. Absolute executable paths, parent traversal, and the retired `chromePath` field are rejected before dispatch.
- **Persistence is not yet proven.** `browserProfileDirectory` is currently a portable relative directory. It becomes durable only when the process owner resolves a named app/account-scoped private-volume binding and proves the profile survives a session restart. The current ephemeral workspace does not meet that contract.
- **No visible-window default.** Default `realness='headless-new'`. The headful-offscreen mode remains data-selectable only for platforms that can actually keep such a window off-screen.
- **One Chrome, N windows.** `browserConnection` is module-scoped (one process); each surface is its own window/target so every surface composites and screencasts independently (Chrome only streams the foreground/composited page — true in both realness modes). Re-mounts reuse, not relaunch.
- **No false cleanup claim.** Realm teardown requests `Browser.close` and `end_session`. The native owner must still prove descendant lifecycle ownership on every exit path; Darwin process groups alone cannot own a `setsid` or double-fork escape.
- **Isolation evidence is native-bound and short-lived.** The process start explicitly opts into bounded surface-observation publication. The returned publisher token stays only in provider-realm memory, is discarded on bootstrap/process loss, and is never written into package DATA. Native publication binds the observation address/hash to the running process-session snapshot; ordinary target recovery and disposal confirm exact revocation first, while whole-process termination retracts all bindings atomically.
- **No cross-provider inference.** This contract proves only a surface created and observed by `browsing-surface-provider`. It does not certify Aside, a personal browser, or any provider whose runtime is not the process-session named by the observation.
- **Watchdog-lift bridge.** React 19 does not invoke `onLoad` for a custom element, so the surface dispatches a bubbling DOM `load` AND calls the `onLoad` React parked on the element (`__reactProps$*`) on every paint. Without this, `web-frame`'s 15s blocked-watchdog never lifts.
- **Stable tag.** `customElements.define` is permanent per tag per realm; the production tag is the unversioned `bitfield-browsing-surface`.
- **Surface fills its pane + refits on resize.** The custom element is `width/height:100%` (not just `display:block`, whose auto height never tracked a pane drag → "resize does nothing"). A `ResizeObserver` watches the element AND its parent pane; `resize()` is no-op-guarded, restarts the screencast clean (stop→start so new device-pixel caps apply), and forces an immediate `captureScreenshot` repaint so even a static page refits instantly on every drag.
- **One network reach, declared.** The realm orchestrates a native Chrome process and never touches disk. It does open ONE socket itself, the CDP WebSocket to that process at the address the process-session endpoint returned, and that reach is declared as a `reaches-past-the-engine` row in the manifest; the entry-bytes builder refuses to compile the module without it. Until 2026-09-09 this line read "never does network/disk itself", which was false twice over: the CDP socket, and a diagnostics `fetch` to a frozen loopback beacon, since deleted.
- **Capture is evidence, not an editability claim.** Missing resources and inaccessible matched-style nodes remain explicit error rows. DOM interpretation belongs to a separately admitted decoder leaf; this provider only acquires browser-native evidence.

## Dependencies

- **Depends on:** the realm transport `globalThis.__BITFIELD_BOOT_HOOKS__.connect()` (`transport.invoke`, `transport.onAddressByteSegmentUpdate`); engine targets `compute.process_session` and `engine.operation.label-addressed` (`read-current`); an app-open-verified `browser` runtime binding; and an owner-provisioned private-volume binding for durable identity.
- **Depended on by:** the `web-frame` package (`show/WebFrame.tsx` `FrameEmbed`, via `canUseRuntimeBrowsingSurface` / `getRuntimeBrowsingSurface`).

## macOS note

The default is headless and creates no browser window. `headful-offscreen` is not treated as invisible on macOS: the OS can clamp or move the window onto a display, so that mode requires an explicit platform realization and visual proof.
