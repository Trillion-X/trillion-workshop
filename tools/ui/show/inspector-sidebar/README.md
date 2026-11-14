# inspector-sidebar

Generic right-rail editor: renders the data sources resolved for a clicked element (via `inspection-ref`) as titled sections with typed editors, and dispatches edits through host-injected write transports.

## Files

| File | Purpose |
|------|---------|
| `InspectorSidebar.tsx` | The sidebar: per-source sections; a plain value is one row of the shared inspector (`tuning-panel` TuningControl, drawn by the source's `setting` or from the value itself: a colour code as a colour, a number as a number field, on/off as a switch, words as words; a source with its own setting row is drawn by that row's control whatever its value's shape, so a shadow object is a shadow control, and a value never set shows the row's `default_value`), changed on screen at every move and kept 350 ms after the moves stop; structured and injected editors; read-only provenance for sources without a write descriptor, pending/failure states. Proven by `test/inspector.test.mjs` (a board's thing: three moves, one write). |
| `index.ts` | Barrel export. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `InspectorSidebar` | `({sources, loadRecord, dispatchWrite, onClose, title?, renderFieldEditor?, emptyText?, computedText?, logger?}) => JSX` | The sidebar. `title: null` draws only the sources, for a host that puts them in its own window (the board's Edit details opens them in the shared FloatingPanel). Owns NO I/O — `loadRecord` and `dispatchWrite` are injected by the host. |
| `InspectorSidebarProps` | see above | `dispatchWrite(write, input, source)` receives the substituted input template; kind→transport routing is the HOST's registry. |
| `InspectorFieldEditorProps` | `{value, pending, commit}` | Contract for host-injected editor overrides via `renderFieldEditor`. |

## Dependencies

**Depends on:** `ui` Button/Container/Spinner/Text, `ui/show/tuning-panel` (TuningControl), `ui/show/structured-value-editor`, `ui/show/inspection-ref`.
**Depended on by:** `group` GroupBoardPanel (a thing on the board: Alt-click or Edit details), `visual-database` VisualDatabaseSurface (a row or card).

## Invariants

- No write descriptor on a source → read-only rendering + "shown from saved data" line — never a fake editor (L117).
- No package names, no domain vocabulary, no closed editor enum: the shared inspector row (by `source.setting`) or the structured built-in + host `editorForShape`/`renderFieldEditor` overrides.
- Root carries `data-floating-layer` (shared overlay marker) and its own inspection stamp (`family:'inspector'`) — the inspector is itself inspectable.
- Edits substitute the owner's `inputTemplate` (`$value`/`$record`) and dispatch through the injected transport; the sidebar never chooses a write path.
