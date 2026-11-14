# tuning-panel

The one inspector: any record's settings (a colour, a size, a shadow, a timing curve, a choice, an on/off) are DATA rows drawn as design-tool controls you can see and drag, with the typed value still there, beside the real thing being tuned; every move changes it at once. A caption style, a shape on a board, a part of a page, a grid column and a record's fields are all setting rows drawn here.

## Files

| File | Purpose |
|------|---------|
| `TuningPanel.tsx` | The panel (titled sections that fold away), the per-setting control (placed beside, under, or in the inspector's label column by `TUNING_PLACEMENT`; a row may hold several settings side by side), the colour field (swatch + wheel + typed colour code), the track field (drag + typed number + unit), choices drawn as themselves, the sample tile, and the widget map. |
| `TuningFields.tsx` | The fine controls (Figma and Diffusion Studio anatomy, no code taken): `ScrubField` (a number with a prefix you drag sideways, type, or nudge with arrow keys, Shift for ten steps), `ShadowField` (x, y, blur, spread, colour, opacity; Add shadow / remove), `CurveField` (a timing curve drawn as itself, two handles to drag or move by keyboard, named curves); the one meeting of a shadow or a curve with CSS text (`shadowCss`, `readShadowCss`, `curveCss`, `readCurveCss`, `curveOf`) and every widget's CSS form (`settingFromCss`, `settingToCss`). |
| `TuningSplitPreview.tsx` | A two-pane window with one edge to drag, drawn to a real stage's scale: snap marks, shaded minimum ends, the edge settling with the caller's softness. Where the edge lands is the caller's `snap`. |
| `index.ts` | Barrel export. |
| `settled-write.mjs` | Serializes complete edited snapshots, settles rapid changes, flushes on departure, and retains failed writes for retry. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `TuningPanel` | `({ sections, values, onChange, preview?, header?, footer?, className?, disabled?, search? }) => JSX` | Sections of setting rows beside an optional preview of the real thing; preview above in a narrow pane, beside in a wide one (container query `tuning`). Optional `search: {label, placeholder, empty}` searches section and setting metadata, reveals matching folded sections and restores folds on clear or Escape. Search never writes a setting. |
| `TuningControl` | `({ setting, value, onChange, values? }) => JSX` | One setting row: optional sample tile, label, Reset while different from `default_value`, and the control from `TUNING_WIDGETS`; a row with `settings` draws each of them side by side from `values`. Used alone by `visual-database` (grid column appearance) and `InspectorSidebar` (a record's fields). |
| `TUNING_PLACEMENT` | `Record<string, 'under' \| 'column'>` | Where each widget's control sits; any widget not listed sits beside its label. A shadow and a curve sit under their label at the panel's full width, so their fields stay readable in a narrow panel. |
| `ScrubField` | `({ label, prefix?, value, min?, max?, step?, unit?, onChange, className? }) => JSX` | A design-tool number field. |
| `ShadowField` | `({ label, value: TuningShadow \| null, unit?, onChange }) => JSX` | A shadow, or the button that adds one. |
| `CurveField` | `({ label, value: TuningCurve, presets?, onChange }) => JSX` | A timing curve. |
| `TuningShadow` | `{ x, y, blur, spread, colour, opacity }` | A shadow as DATA. |
| `TuningCurve` | `readonly [x1, y1, x2, y2]` | A cubic Bézier timing curve. |
| `settingFromCss` / `settingToCss` | `(setting, text) => value` / `(setting, value) => text` | A setting's value read from and written as CSS by its widget (numbers with their unit, shadows, curves). |
| `TUNING_WIDGETS` | `Record<string, (props: TuningControlProps) => ReactNode>` | Widget id to control: `color`, `slider`, `number` (ScrubField), `select` (a list that opens; None first when there is no default), `shadow`, `curve`, `segmented`, `toggle` (with two options, their values off then on), `choices`, `many` (several choices on at once), `words` (typed words), `button` (each choice drawn as the shared button in that look), `icon` (each choice drawn as its icon), `hue` (each choice a swatch of the shared palette, `data-colour`). A new kind of control is one entry. |
| `TuningColorField` | `({ label, value, presets?, onChange }) => JSX` | Swatch opening `ColorPickerPopover` with live changes, colour code typed beside it. Also the shadow's colour. |
| `TuningSliderField` | `({ label, value, min, max, step, unit?, onChange }) => JSX` | Filled track to drag plus a typed number with its unit. |
| `colourCode` | `(value: string) => string \| null` | A colour as a code the wheel starts from: codes pass through, rgb()/rgba() become #rrggbb(aa); null when it cannot be read. |
| `TuningSampleTile` | `({ sample, value }) => JSX` | A small tile with one CSS property set to the value, so a size or a corner reads as a picture. |
| `TuningSplitPreview` | `({ stagePx, minPx, marksPercent, easeMs, snap, startShare?, className? }) => JSX` | The `preview` for anything split in two; `snap(requestedPx, stagePx) → {px, snapped}` is the real thing's own snapping. |
| `TuningSetting` | `{ key, label, widget, min?, max?, step?, unit?, options?, options_drawn_with?, presets?, sample?, note?, default_value?, prefix?, settings?, path? }` | One setting as DATA (`prefix` the number field's drag handle, `settings` rows drawn side by side, `path` the caller's field). |
| `TuningSection` | `{ id, title, settings }` | A titled group of settings. |
| `TuningValue` | `string \| number \| boolean \| readonly string[] \| readonly number[] \| TuningShadow \| null \| undefined` | A setting's value (null: a thing taken away, such as a shadow). |

## Usage

```tsx
<TuningPanel
  sections={[{ id: 'colours', title: 'Colours', settings: [{ key: 'bg', label: 'Background', widget: 'color' }] }]}
  values={{ bg: '#0a0a0a' }}
  onChange={(key, value) => paint(key, value)}
  preview={<TheRealThing />}
/>
```

## Invariants

1. Settings are DATA; the panel never names a setting.
2. Controls are looked up by widget id, and placed by `TUNING_PLACEMENT`; never a branch on the id.
3. Every move calls `onChange` at once; keeping a change is the caller's.
4. `disabled` prevents control edits while the caller commits the displayed values; the footer remains available for recovery.

## Dependencies

**Depends on:** `ui` ColorPickerPopover, SegmentedControl, Switch, Dropdown, NamedIcon, Button, Textarea, cn.
**Depended on by:** `screen-look` CompactScreenLookThemeEditor (look editor), `ui` public-app-editor VisualHtmlEditor (selected element style, style-settings.json), `ui` InspectorSidebar (a record's fields), `visual-database` VisualDatabaseSurface (grid column appearance), `group` item-renderers (`shadowCss`), `src/workspace/media-edit/captions-panel.tsx` (caption style), `src/workspace/canvas-edit-screen.tsx` (a picked part on a canvas), `screen-arrangement` pane-size settings.
