# Reference-Grounded Screen Contract: Media Composition

## Live Package Truth

- Package set: `example-school-of-tennis`
- Package: `media-composition`
- Live authority: selected Example app log; package-set owner-log admission is closed by the 90-package repair packet.
- Boundary file: `bitfield-packages/packages/media-composition/things-to-store-and-run.json`

## Human Job

- Primary job: choose media, edit a timeline, preview the composition, and render/export the result.
- Dominant action: make an edit decision or render the composition.

## Capability Inventory

- Real capabilities to expose: media workspace, selection, plan, timeline, edit decisions, markers, render manifest, handoff, export folder, EDL, preview, and video compose/render actions.
- Hidden capabilities: ffmpeg/process descriptors, raw source bytes paths, package records, source hashes, workflow internals, and destination publishing.

## Reference Inventory

- Contract references: `ai-command-center/notes/projects/packages-and-package-sets/tennis-chess/reference/2026-06-20-tennis-product-constellation-mobbin-reference-contract.md`
- Mobbin seed references:
  - Instagram iOS video editing screen: `https://mobbin.com/screens/371a65ea-5a05-41e3-9ecc-14a46b7c56a2`
  - Paramount+ iOS media library/card screen: `https://mobbin.com/screens/944c5951-29f6-45ef-8707-a1746326f8ce`
  - Paramount+ iOS media detail screen: `https://mobbin.com/screens/cf3a75a1-d733-4bf9-9b72-8568ba87eb28`
  - Paramount+ iOS playback entry screen: `https://mobbin.com/screens/73ba659c-067d-4dd2-b5a4-a27c379cf0e7`
- Tool/MCP references: Claude frontend agents still owe refreshed Mobbin MCP screenshots in `bitfield-packages/packages/media-composition/proof/mobbin-reference-proof.md`.

## Reference Anatomy

- Layout: media library, preview player, timeline, tool/action rail, and export status.
- Density: preview and current timeline action dominate.
- Typography: clip title, current edit, and export status are primary; technical render details stay hidden.
- Surfaces: media cards, preview area, timeline track, marker rows, tool buttons, and export sheet.
- Motion: scrubber, preview updates, and render progress belong to the Mobbin-proofed UI wave.
- States: empty, sparse, dense, editing, preview, exporting, export complete, error, mobile, and desktop.
- Mobile/desktop: mobile stacks preview, tools, and timeline; desktop can use a multi-panel editor.

## Translation Boundary

- Banned primary UI terms: package, workflow, slot, envelope, payload, descriptor, ffmpeg, raw path, CAS, hash, runtime, debug, MCP, Mobbin, proof, and acceptance criteria.
- Human terms: clip, timeline, preview, marker, trim, overlay, audio, export, render, and ready.
- Data-to-control mapping: workspace records become editor state; selection records become active clips; edit decision records become timeline changes; render manifest and output records become export status.

## Shared Primitive Plan

- Reuse `ui` icon buttons, sliders, tabs, list, sheet, loading, empty, and error primitives.
- Reuse `screen-look` spacing, type, focus, and responsive layout.
- Elevate reusable `MediaPreview`, `TimelineTrack`, `MarkerList`, and `ExportStatus` primitives after screenshot proof.

## Render-State Matrix

- Empty: no selected media.
- Sparse: one clip and one timeline decision.
- Dense: many clips/markers stay scannable.
- Loading: preview and timeline retain stable dimensions.
- Error: render or edit error is human-readable.
- Mobile: preview first, timeline and tools below.
- Desktop: library, preview, timeline, and inspector can coexist.

## Visual Proof

- Capture path: `bitfield-packages/packages/media-composition/proof/visual-proof.md`
- Acceptance checks: choose media renders, preview/timeline render, edit action submits, export/render status renders, backend terms absent from default UI.
