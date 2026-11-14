# structured-value-editor

Generic recursive field editor/viewer for unknown JSON-shaped values — objects as labeled field rows, arrays as item rows, scalars as typed inputs; raw text only behind an "Edit as text" disclosure.

## Files

| File | Purpose |
|------|---------|
| `StructuredValueEditor.tsx` | The recursive editor (fields, nested groups, array rows, typed scalars, text fallback). |
| `index.ts` | Barrel export. |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `StructuredValueEditor` | `({ value, onChange?, readOnly?, maxDepth? }) => JSX` | Renders any JSON-shaped value as editable/readable field anatomy. Emits the FULL new value on each edit. |
| `StructuredValueEditorProps` | `{ value: unknown; onChange?: (v: unknown) => void; readOnly?: boolean; depth?: number; maxDepth?: number }` | Props. `depth` is internal. |

## Dependencies

**Depends on:** `ui` Button/Container/Icon/Input/Textarea/Text/Toggle, lucide icons.
**Depended on by:** `workflow-canvas` (step editing/detail); any package needing structured payload editing without raw JSON.
