# public-app-editor

The page editor for a Trillion site: the page drawn at every size side by side on one canvas (GrapesJS), its layers, the selected part's style in the shared inspector, the people editing with you, and the controls a public page uses to run a capability.

Metadata-only `edit_public_app_draft` calls use the existing revision-leased file owner. Visitor actions and placements save together while the complete installed file index stays intact; the returned draft retains the editor's page preview and index reference. An indexed page preview is not a complete replacement for all site files.

## Files

| File | Purpose |
|------|---------|
| `VisualHtmlEditor.tsx` | The editor: the page at each size in `breakpoints.json` on one infinite canvas, layers named by `layer-names.ts`, the selected part's style drawn by the shared inspector (`tuning-panel` TuningPanel over `style-settings.json`, read and written as CSS by each row's widget through `settingFromCss`/`settingToCss`), who a change reaches (`change-scopes.json`), other people's cursors and outlines on every frame, and `takeChanges(html, css)` to bring in someone else's saved change without losing yours. |
| `LazyVisualHtmlEditor.tsx` | Loads the editor only when a page opens, so the Sites list stays light. |
| `PublicCardOptions.tsx` | The options of a site's public card (title and look of the card that links to it). |
| `layer-names.ts` | What the layers call each element and its mark, read from `layer-kinds.json`. |
| `selection-ref.ts` | `VisualSelectionRef`: what a selected element can prove about itself (page path, route, element address). |
| `placed-capability-runtime.mjs` | Runs a capability placed on a public page and draws its result, from the current Trillion host. |
| `public-app-run-form.mjs` | The schema-driven form a public page shows for a capability it can run. |
| `breakpoints.json` | DATA: the sizes laid side by side on the canvas and the gap between them. |
| `change-scopes.json` | DATA: who a style change reaches (the selected part, the picked parts, or every part sharing its facts). |
| `editor-layout.json` | DATA: tool rail, tab labels, panel size bounds, keyboard resize step and property-search copy. |
| `Frappe-Builder-LICENSE.txt` | Upstream MIT notice for the adapted editor interactions and layout. Included in the shipped open-source notices when the editor is bundled. |
| `layer-kinds.json` | DATA: how layers name and mark each kind of element. |
| `style-settings.json` | DATA: the style rows of the selected part (Type, Fill, Size and shape, Shadow, Motion), one CSS property each; a property to tweak is one row. |
| `README.md` | This file. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `VisualHtmlEditor` | `forwardRef<VisualHtmlEditorHandle, { html, css, revision, libraryItems?, pages?, selectedPage?, onChoosePage?, references?, referencesQuery?, referencesStatus?, onSearchReferences?, onSelection?, onReady?, selectionPanel?, peers?, onPointer? }>` | The editor. |
| `VisualHtmlEditorHandle.takeChanges` | `(html: string, css: string) => boolean` | Brings in a saved change by element address; false when it cannot be merged. |
| `CanvasPeer` | `{ id, name, color, cursor?, target?, doing? }` | Someone else on the page. |
| `EditorLibraryItem` / `EditorReference` | data rows | What the editor offers to add, and studied screens to start from. Placeable catalog rows set `canDrag` and use their existing `onChoose` owner for canvas drops; their shared Button remains the keyboard and click path. |
| `publicAppRunForm` / `publicAppActionForm` | `(run) => HTMLElement \| null` | A capability's form on a public page. |
| `publicAppActionForm.readActionAnswer` | `() => object \| null` | Validates without losing typed values; returns canonical typed action fields or focuses and explains the error. |
| `publicAppRunResult` | `(result, value, schema) => HTMLElement` | Its result. |
| `placedCapabilityRuntime` / `placedCapabilityScript` | function / its source as a script | What a public page runs to draw its placed capabilities. |
| `PublicCardOptions` | `({ initial, visitorView, operation, canRun, onApply, onClose }) => JSX` | A site's public card options (`PublicCardPresentation`, `PublicVisitorView`). |

## Dependencies

**Depends on:** `grapesjs`, `ui` tuning-panel (TuningPanel, settingFromCss, settingToCss), SplitDividers, LayerTree, SearchField, SegmentedControl, Button, NamedIcon, `screen-look` public-app-editor.css.
**Depended on by:** `src/workspace/public-apps-screen.tsx` (Sites), public app pages (`placed-capability-runtime.mjs`).

## Invariants

1. Styles, sizes, scopes and layer kinds are DATA rows; the editor names none of them.
2. A style row's value meets CSS only through its widget's CSS form, so a shadow, a curve or a size round-trips the same way everywhere.
3. `baseUrl` is the selected installation's live or saved-draft page address. Every canvas frame resolves relative images, fonts and CSS resources from that page. The canvas base never enters exported HTML or rewrites its original asset paths.
4. `renderCss` carries canvas-only styles with linked resources rooted at their stylesheet's original path. `css` keeps the original sheets for an unchanged export; changed styles may use app-root resource paths so they remain valid in the saved sheet.
5. Switching tools hides mounted panels instead of discarding their state. Layer expansion, searches and scroll positions survive; opening a different page still resets its tree by `openKey`.
6. Panel resizing uses shared pointer and keyboard dividers, respects the DATA bounds and leaves room for the canvas. It changes editor chrome, never the saved page. Narrow panes put the canvas first and hide the dividers.
7. Property search uses the existing setting metadata and controls. Matches reveal folded sections temporarily; clearing the search restores the person's folds and never changes a property value.

## Source reference

Frappe Builder's MIT Vue source supplied the tool rail, bounded panels, retained tabs, compact panel headings and property-search behavior. These are adapted through Trillion's existing React components and Screen Look. The Frappe backend, document model and provider ownership are not dependencies. The supplied archive identifies no immutable upstream commit. The notice is exact upstream text; `scripts/open-source-notices.json` declares which bundled consumers require it.


## Visitor text controls

Placement DATA can set `multiline: true` on a text field for a six-row message area, or `repeatable: true` for native add/remove entries. Optional `add_label` and `remove_label` name the buttons. The two flags are mutually exclusive and cannot be combined with `from_page_address`. Each repeated row has its own label; adding focuses the new row, and removing focuses the next or previous row, or the Add button when the last row is removed.

Repeated nonempty entries join with newlines into the action's existing text field. There is no fixed entry-count cap and no array wire type. All pasted content remains available to edit: client validation checks the existing 4,000 JS character limit per string, including separators, and the host's 16,384 UTF-8 byte response limit. Oversized content is explained and never silently truncated. Field errors are linked through `aria-describedby`; required fields, sending state and failures are announced.

The action runtime disables all controls during a pending send. A failed response or network error retains every value, restores the prior disabled states and reuses the same idempotency key for the same canonical answer, including when a blank row is added or edits are undone. Success uses the placement's existing thank-you message.

The source search `repeatable form fields textarea add remove links` did not return a usable 21st.dev result (connector failure), and this session had no Mobbin connector. The change reuses the existing shared native form controls and Screen Look tokens; no upstream component or proprietary source was copied.
