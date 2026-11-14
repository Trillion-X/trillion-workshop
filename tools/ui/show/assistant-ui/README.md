# assistant-ui — unchanged upstream source

`source/` was copied with `cp -R` from Alex's assistant-ui repository snapshot.
The 20 upstream test files are retained in that original collection and excluded
from this shipped source directory. They are not imported by any Expansion bundle
and are not declared as this package's executable checks. Expansion's actual
source-integrity and browser tests remain the evidence for this integration.
It is not handwritten or restyled component code. Expansion imports the actual
`elements/thread.aui.tsx` and its dependency graph. The build aliases the default
UI imports to the upstream **Base UI** variant, which its `render` props require.
Mapping those imports to Radix compiles but breaks the controls.

Expansion's `conversation.tsx` only supplies transport, context, drafts, media
links and results through `useExternalStoreRuntime`. Onyx's unchanged Root/App/MainContent layout supplies the inner frame. Model execution is still
Expansion's existing backend; this is not an OpenMausBot integration.

The source theme is copied into `packages/screen-look/show/assistant-ui-theme.css`.
The compiler isolates its selectors and removes CSS layer precedence conflicts
with the existing application. Original source files remain byte-identical.
Local HTTP posters become same-origin fetched blob URLs because assistant-ui's
image converter intentionally accepts HTTPS, blob and image data URLs, not HTTP.

The actual build input hashes are in Expansion's `conversation.sources.json` and
`shared-controls.sources.json`. Tests compare imported files against originals.
MIT license is included in the installed third-party notices.

`disclosure.tsx` hosts existing DOM form content inside the unchanged licensed
Base UI Accordion, preserving input nodes and event owners while collapsed.
The adapter exposes open/dispose for invalid-field recovery and dialog cleanup.
Expansion uses it for optional color, audio and output settings in draft review.

`floating-workspace.tsx` wraps the existing thread in official MIT react-rnd 10.5.2 for pointer/touch drag and resize. Existing authored DraggablePanel provides anchor-reset drag but no resize/dock; FloatingMaterialFrame provides placement only. This adapter uses licensed interaction machinery and adds docking, keyboard movement, saved geometry, and viewport clamping without remounting its children. `AttachmentOwner` routes the unchanged source plus button to the caller’s real attachment picker. Appearance lives in screen-look/floating-workspace.css. The closed frame keeps invisible layout so react-rnd measures its initial position correctly.

`result-actions.tsx` renders caller-validated current results using the unchanged source Button. It neither derives readiness nor creates arbitrary file links; the app provides scoped result IDs and invokes its existing protected editor.
