# rule-filter

The filter a person builds over any list of records: a Linear-style Filter menu (search, every field, hover a field for its values with counts, a project tree nested under its parents, or its comparisons), segmented chips under the view bar, one per rule or group, and a builder where every line reads Where / and / or, rules nest into groups, and any group turns into its opposite with Not. The rule tree it edits is exactly what the formula engine compiles and evaluates (`formula-engine/rules/compile-rules.mjs`); this folder never decides which records match.

## Files

| File | Purpose |
|------|---------|
| `RuleFilter.tsx` | `RuleFilterMenu` (the Filter menu), `RuleFilterChips` (chips and the builder popover anchored under them), the builder (field and comparison pickers as shared menus, a hover "…" per line to duplicate, group or remove, the Not switch), and the value controls (checklist with counts and a Show only the ones I pick / Hide the ones I pick switch, a range as three rows that never share space: the two ends, the track, the typed ends; a day; several words or phrases as removable tokens before a box; one value). Lines reorder by dragging their grip. A builder opened with no rules starts with one line waiting for its field. |
| `rule-tree.ts` | Rule tree types and the pure path-copying edits (add, replace, remove, duplicate, wrap in a group, toggle one value, read back from storage). |
| `rule-value-formats.ts` | How a number reads and parses per field kind: length `1:30`, size `250 MB`, date `Sep 26, 2026`; any other kind is a plain number with its unit. |
| `FocusEditor.tsx` | The workspace switcher at the top of a sidebar: the Focus a whole app is about, shown by its name (or Everything). Its menu lists Everything, then each field's values (each space, each pursuit) with a check on the chosen one, and a way to build any rule over them with `RuleFilterChips`. `mountFocusEditorInto(hostId, props)` mounts it into the host a sidebar draws (`data-sidebar-content-host`); `mountFocusEditor(host, props)` into any element. Every word is the app's (`words`). Anatomy after Notion's workspace switcher (Mobbin fa0f3ae6-c4cc-432f-87ba-77e66f63146e). |
| `focus-chain.ts` | One filter at every level (app, arrangement, screen, view): a path of node ids whose rules are ANDed root first; a rule over a field a list does not hold never hides its records. |
| `focus-records.ts` | Host-injected rule store and path resolver; signed-in lists share the account's recursive scope owner, while public lists load no account transport. |
| `index.ts` | Public exports. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `RuleFilterMenu` | `(props: {fields, operators, value, onChange, facets?, trigger?, triggerContent?, onOpenBuilder, onFieldOrderChange?}) => JSX` | The Filter menu; a toolbar passes its own trigger. Values toggle in place (the menu stays open); a comparison that needs a value opens the builder. |
| `RuleFilterChips` | `(props: {fields, operators, value, onChange, facets?, builderOpen, onBuilderOpenChange}) => JSX` | Chips joined by the group's word, Clear, and the builder popover. |
| `RuleFieldView` | `{id, label, kind, unit?, icon?, values?, pickValues?}` | A field a person can filter by; `kind` picks comparisons via `applies_to`. |
| `RuleFacet` | `{options?: {value, count}[], min?, max?}` | What exists for a field: value counts and measured range. |
| `RuleOperatorData` | `{operators: RuleOperator[], combinators: RuleCombinator[]}` | formula-engine `rules/rule-operators.json`. |
| `RuleGroup` / `Rule` / `RuleNode` | `{kind:'group', combinator, negate, rules}` / `{kind:'rule', field, operator, params}` | The saved and evaluated tree. |
| `toggleValue` | `(root, data, field, value, operatorId?) => RuleGroup` | Add or remove one value on the field's top-level list rule (tag clicks); `operatorId` picks keep or hide. |
| `countRules` | `(node) => number` | Lines that decide something; a line still waiting for its field is not counted. |
| `holdsValue` | `(root, fieldId, value) => boolean` | Whether a tag is currently narrowing. |
| `readRuleTree` | `(value, data) => RuleGroup` | A stored tree, or an empty group. |
| `duplicateAt` / `wrapAt` | `(root, path) => RuleGroup` / `(root, path, data) => RuleGroup` | Copy a line beside itself; put a rule in its own group. |
| `appendAt` / `replaceAt` / `nodeAt` | path-copying edits by `RulePath` (`number[]`) | Tree edits sharing untouched branches. |
| `formatFor` | `(kind) => ValueFormat` | Words for a measured number. |
| `FocusEditor` | `(props: {nodeId, fields, facets, operators, store, words: FocusEditorWords, opens?: {id, label, icon, open}[]}) => JSX` | The workspace switcher; `store` is a `NodeRuleStore`; `opens` are rows after the values that open something (the app's list of every value) instead of switching. |
| `FocusEditorWords` | `{everything, several, filtered, more, label, search}` | Every word the switcher says; `filtered` names a rule such as text that chooses no named values. |
| `mountFocusEditorInto` / `mountFocusEditor` | `(hostId, props) => () => void` / `(host, props) => () => void` | Mount it into a sidebar's content host or an element. |
| `effectiveRule` | `(path, rules, {all, canRead?}) => {rule, applied, notNarrowing}` | The rule a list at `path` runs. |

## Dependencies

**Depends on:** `../action-menu` (Filter menu, field, comparison, joining-word and row menus), `../coss/ui` (Button, Checkbox, Input, Popover, Slider; MIT Coss source, provenance in `../coss/provenance.json`), `../icon` (NamedIcon), `../search-field` (SearchField, a field's value search), `../drag-reorder-list/SortableRows` (line reorder), `@base-ui/react`. The words comparisons are `formula-engine/rules/rule-operators.json` rows with `input: "words"`; `test/formula-rules.test.mjs` proves them in the engine.

**Depended on by:** `../record-views` (the Filter in the view bar), media-workspace Library and Schedule through the shared-controls bundle. Appearance: `screen-look/show/rule-filter.css` (including `rule-filter-words` / `rule-filter-word` tokens and the line grip), `drag-reorder.css`, `search-field.css`.

## References (inspiration only, no code copied)

Notion filter (Mobbin b801453a-b5a3-4a54-913d-c5381b7113c5, 24295cd3-d92b-453e-8566-2f4f50fe14db, d8abbe0b-4c55-4316-91b7-2e6b4baecb52), Airtable (3de03dd6-b397-49fb-9fee-f194f1456e6a), Flodesk "Matching all | any" (04ff770f-c284-48a4-83ea-6ab99b784fc3), Linear (ed670cda-0527-4716-a1a6-0159f12c4f42, d1d26f7d-e1e5-490f-ab4f-c96dd12854c1), Notion builder "Where / And" (d41e1c3f-7554-4129-af21-b8d1c8eace43), Airtable one-line condition (f2241482-541b-4d10-9295-0cd14783fc45, fe234e59); 21st.dev 1633 Filters (segmented chip), 11567, 31804; ReUI Filters (keenthemes/reui, MIT: chip bar plus advanced builder); 21st.dev 27325 Advanced Data Table Filter Builder, 26824 Filter Token Bar, 31347 Slider (no licence stated, so anatomy only).

## Invariants

- No field, comparison, value or product name in this folder; everything open is DATA.
- The control that edits a value is chosen by the comparison's `input` through `INPUT_CONTROLS`.
- Words rules commit after typing pauses (350 ms), so a server-filtered list is asked once per word.
