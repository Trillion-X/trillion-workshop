# lifecycle-rules

Blind editors for "what happens to a record after some days": a duration choice and an ordered rules editor.

## Files

| File | Purpose |
|------|---------|
| `LifecycleRules.tsx` | `DurationChoice`, `LifecycleRulesEditor` and their DOM mount functions. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `LifecycleSettings` | `{default:{after_days}, suggestions:[{after_days}], rules:LifecycleRule[]}` | The document the editor edits and hands back. |
| `LifecycleRule` | `{id,label,enabled?,when:[{field,op,value}],then:{action,after_days,since?}}` | One rule; the first enabled matching rule decides. |
| `LifecycleField` | `{id,label,kind?,values?}` | A comparable field; `kind:'date'` fields are offered as "counting from". |
| `LifecycleOperator` | `{id,label,needs_value,applies_to?}` | A comparison; `needs_value:false` hides the value input. `applies_to` lists the field kinds that offer it. |
| `operatorsForField` | `(operators, field?) => LifecycleOperator[]` | The comparisons a field offers, by its `kind`. |
| `DurationChoice` | `({label,value,suggestions,onChange,onAddSuggestion?})` | Radiogroup of quick choices plus a custom number of days. `null` = keep indefinitely. |
| `mountDurationChoice` | `(node, props) => {value()}` | DOM mount for app code. |
| `LifecycleRulesEditor` | `({value,fields,operators,actions,defaultLabel,onSave,onCancel?})` | Default window, quick choices and rule cards. |
| `mountLifecycleRulesEditor` | `(node, props) => void` | DOM mount for app code. |
| `durationLabel` | `(days) => string` | "7 days", "1 day", "Keep indefinitely". |

## Dependencies

**Depends on:** `coss/ui` (Button, Input, Checkbox, Select), `coss/workspace-controls` (`mountSharedContent`), `lucide-react`. Appearance: `screen-look/show/coss-workspace.css` (`.lifecycle-*`).

**Depended on by:** Expansion (`dev/media-workspace`): archive settings and the per-recording "Keep for…" choice.

## Invariants

- Fields, operators, actions and quick choices are DATA from the caller; nothing here names a product concept.
- `after_days: null` means keep indefinitely end to end; a custom number is emitted only when it is a whole number from 0 to 36500.
- The editor owns only draft state; the caller validates and saves.

## References

21st.dev "Segmented Control" (id 23552) for the radiogroup anatomy, "Advanced Data Table Filter Builder" (id 27325) for field · operator · value rows; Mobbin: Apple Photos Recently Deleted (https://mobbin.com/screens/c74527da-0e05-4ef2-af4b-c11a631b9217).
