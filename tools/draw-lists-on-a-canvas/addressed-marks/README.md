# Addressed Marks

Package-owned mark operation, style, tool, and workflow-action records, plus the ink physics (capture, tool point-mappers, materialization, erase-by-reference) that lets any space owner make its addressed spaces drawable.

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | Package boundary: entry, capability, input descriptors (`mark-operations`/`mark-styles`/`mark-tools`), materializers, seeded style palette + tool records, `action:record-addressed-mark-operation` workflow definition, public-source declarations. |
| `read-data/addressed-marks.ts` | Pure reader/materializer physics: record decoding, target keys, reference-effect composition (append/hide/restyle/split/merge/reorder), tool point-mappers (`passthrough`/`segment`/`polygon`), operation-local style merge, erase hit-testing (`nearestMarkPathRef`). **NEW:** `decoration?: VisualLayerStackRecord` on marks reuses the ui capability registry (solid/gradient/mesh/image/video/grain/tint). Back-compat conversion of legacy `fill` fields to single solid-capability layer. |
| `read-data/ink-fade.ts` | `inkOpacity`, `inkGoneAt`: how visible a mark is at an instant, from its own `createdAt` and hold and fade rules; `AddressedMarkLayer` draws marks at that opacity when given `fade`. `test/ink-fade.test.mjs`. |
| `starting-marks.json` | The colours (Ink, Accent, Green, Amber, Red, Contrast, Highlight) and tools (Pen, Line, Rectangle, Ellipse, Erase) every drawing starts with, as DATA; `use-mark-data.ts` puts the person's saved ones after them (same id replaces). |
| `show/keep-marks.ts` | THE one keeper of ink, colours and tools: answers `action:record-addressed-mark-operation` / `-style` / `-tool` on `slot::workflow` as soon as any mark surface loads. Ink goes to the first `addInkPlace` that holds its target (a space's board keeps its ink in the space), else to the person's own records (`addressed-marks.operations` / `.styles` / `.tools`). |
| `show/shown-marks.ts` | Marks shown on this page and never kept (a tour's pointers, doodles and shapes): `showMarks(key, rows)` / `hideMarks(key)` with rows in the one mark-operation shape, `showStrokes(key, target, strokes)` making rows from `{ tool, style, points }` by the starting tool and colour ids with the person's own drawing mapper, and `useShownMarks()`, which `useMarkOperations` merges into every mark layer. |
| `do-work/record-mark-operation.ts` | Append-only operation writer through `slot::workflow` `action:record-addressed-mark-operation`. |
| `do-work/record-mark-style.ts` | Append-only style writer through `action:record-addressed-mark-style` — custom colors/palettes are records in current log state. |
| `show/MarkSessionContext.tsx` | Ephemeral drawing session owner: enabled, `area` + `drawIn(area, enabled?)` (an opaque id the space owner gives meaning: one pane or the whole screen in the arrangement), active tool/style records, stroke-width override, optimistic operations, last target. |
| `show/MarkInputLayer.tsx` | THE single drawing input surface. Caller supplies `resolvePointerSpace(clientX, clientY)`; one stroke = one addressed space resolved at pointer-down. |
| `show/MarkToolbar.tsx` | Drawing toolbar — tools/colors/shapes from records, width presets, fill toggle, show/hide marks, shared ui native color picker + shape maker saving records, undo (append `hide_refs`), done. Docks to any edge / floats via the generic ui dockable-placement primitive (ephemeral session placement). |
| `show/AddressedMarkOverlay.tsx` | Display overlay for one target: log feed + session optimistic merge; optional standalone interactive mode. |
| `show/AddressedMarkLayer.tsx` | Pure SVG materialized-path renderer (also used by the standalone surface). In its standalone interactive mode (normalised 0..1 frame, `onRecordOperation`) it takes `tools` and `selectedToolRef`: the tool's mapper shapes the stroke (line, rectangle, ellipse) and an erasing tool records `hide_refs` for the paths it passes within `eraseRadius`; with no tools every stroke is freehand. The Chrome extension's Mark up (`extension/src/markup.tsx`) draws with it. |
| `show/AddressedMarksSurface.tsx` | Standalone marks surface (deactivated as a placeable destination; not the active drawing route). |
| `show/use-mark-data.ts` | Shared mark input reads through the mounting entry's read scope (tolerant of undeclared scopes); operations are the person's kept ink then the rows shown on this page (`shown-marks.ts`); styles and tools are `starting-marks.json` then the person's saved rows. Importing it starts `keep-marks.ts`. |
| `show/mount-addressed-marks.tsx` | Entry mount for the standalone surface. |

## Key Types / Functions

| Type / Function | Shape | Role |
|------|-----------|------|
| `MarkTarget` | `{ address, frame?, range?, anchor?, readerKey? }` | What a mark points at + which coordinate frame interprets the numbers. |
| `MarkOperationRecord` | append-only op: `{ id, target, toolRef?, styleRef?, body: { coordinateSets, effects, raw } }` | One drawing operation; effects reference earlier ops by ref. |
| `MarkStyleRecord` | `{ id, strokeToken?/stroke?, strokeWidth?, strokeOpacity?, decoration?, fill?, order? }` | Render parameters. **`strokeWidth` is reader SCREEN PIXELS** (paths render with `vector-effect: non-scaling-stroke`). **`decoration?: VisualLayerStackRecord`** — mark's fill via the capability registry (solid/gradient/mesh/image/video/grain/tint). Legacy `fill`/`fillOpacity` fields are converted to a single solid-capability layer at read time (back-compat). |
| `MarkToolRecord` | `{ id, label?, icon?, order?, mapper?, mode? }` | Data-selected behavior: `mapper` picks the point mapper; `mode:"erase"` appends hide ops. |
| `mapPointsForTool(tool, points)` | pure geometry | `passthrough` / `segment` / `polygon(corners|sides,closed)`; unknown kinds → passthrough. An 18-gon is `{kind:"polygon",sides:18}` data, not code. |
| `materializeMarkRecords({operations, styles, target, readerKey?})` | → `MarkMaterial` | Target-keyed visible paths after reference effects; merges operation-local `body.style` over the referenced style. |
| `nearestMarkPathRef(material, point, radius)` | → ref or null | Erase hit-test in target coordinate units. |
| `MarkPointerSpace` | `{ target, toCoordinate(clientX,clientY), hitRadius }` | What a space owner's resolver returns for the point where a stroke starts. |

## Fill Decorations (VisualLayerStackRecord + Clip-Path)

Mark fills reuse the EXACT `ui/show/visual-layer-stack` capability registry that regions use. Marks are NOT a separate fill system.

**Rendering mechanism:**
1. Mark's SVG `<path>` provides **stroke outline** (via SVG stroke attribute) AND **clip geometry** (via CSS `clip-path: path('<d>')`)
2. A DOM `<div>` inside the SVG renders the `VisualLayerStack` component (capability-driven fills: solid, gradient, mesh, image, video, grain, tint)
3. The `<div>` is clipped to the mark path's shape → ALL capabilities work on marks with ZERO per-kind code

**Type:** `decoration: VisualLayerStackRecord | undefined` (same type as region visual layers).

**Adding a fill type = adding a capability, NOT editing mark code (L090).** A new solid/gradient/mesh/image/video/shadow capability is one registry entry. Marks automatically gain it via the blind `VisualLayerStack` renderer.

**Back-compat:** Legacy `fill`/`fillOpacity` fields are converted to a single solid-capability layer at read time. Existing saved styles continue to work as VisualLayerStackRecord.

**Examples:**
- Legacy solid `fill: '#ff0000'` → `{ kind: 'visual-layer-stack', layers: [{ paint: { capability: { capabilityId: 'solid' }, input: { color: '#ff0000' } } }] }`
- New gradient via the registry: same capability, same input format as regions use
- Future mesh/image: automatic, no mark changes needed

## Rules

- `read-data` and `show` are public source roots so arrangement surfaces can mount addressed mark layers without package-specific Runtime Kit branches.
- Active drawing targets addressed coordinate frames. The standalone Marks destination is not the active drawing route.
- Runtime truth is admitted mark records in the log projection, not package source folders or generated byte folders.
- **Stroke width unit contract:** style records author widths in reader screen pixels because every mark path renders with `vector-effect: non-scaling-stroke` (stable ink weight across normalized tab frames, world camera zoom, and any future frame).
- **Read-scope contract:** an entry that mounts mark layers must declare the cross-package read as data in its package's `entry-read-scope-packages.json` (`read_scope_package_data_packages: ["addressed-marks"]`). See `packages/screen-arrangement/entry-read-scope-packages.json` for the canonical declaration. The optional-read fallback in `use-mark-data.ts` is tolerance for undeclared readers, not the contract.
- **Space resolution contract:** space owners own geometry. They mount `MarkSessionProvider`, `MarkInputLayer` (with their resolver), `MarkToolbar`, and display overlays. This package never learns what a tab/window/world/PDF/video IS.
- Erase/undo/clear are append-only `effects.hide_refs` operations — target material and earlier operations are never mutated.

## Dependencies

**Depends on:** `@bitfield/runtime-kit` (entry-scoped read/write), `packages/ui` (cn, NamedIcon, ColorDot, NativeColorPickerPanel).
**Depended on by:** `parts/screen-arrangement` (mounts session/input layer/toolbar/overlays over one pane, the frame and the whole screen; supplies its pointer-space resolvers in `show/mark-targets.ts`; the pane ⋯ menu's Draw rows call `drawIn`), `parts/group` (the board: `BoardMarkLayers.tsx` over its camera, `board-screen.tsx` adds the space-board ink place). Any future space owner composes the same way.
