# rule-builder

Edits an ordered list of allow / don't-allow rules, each read as a sentence a person builds by pointing: **[Allow | Don't allow] [who ▾] to [what they can do: chips, + to add] [+ Only when… fact ▾ is ▾ value ▾]**. Every choice is a menu, a chip or a switch; the only typing is naming a new kind of who (a new member type) and the optional words a stopping rule says. It serves any rule set: everything it offers arrives as DATA.

## Files

| File | Purpose |
|------|---------|
| `RuleBuilder.tsx` | The builder: one card per rule (grip to reorder, effect menu, who menu with kinds and their options nested and "New …" to name one, action chips with a + menu, the shared condition builder for "Only when…", refusal words for a stopping rule, the rule's plain meaning, the owner's refusal beside it, and a ⋯ menu to duplicate or remove), then Add rule, Put back the defaults (confirmed), Discard and Save changes. Read-only, each rule reads as its sentence. `ruleSays` writes a rule's plain meaning from its choices. |
| `index.ts` | Public exports. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `RuleBuilder` | `(props: RuleBuilderProps) => JSX` | The builder. Keeps a draft; hands the whole list to `onSave`. |
| `RuleBuilderProps` | `{rules, effects, whoKinds, actions, facts, operators, readOnly?, problems?, onSave(rules), onRestore?(), words?}` | All DATA; `operators` is formula-engine `rules/rule-operators.json`. |
| `RuleBuilderRule` | `{id, effect, says, refuses?, who?: {kind, [field]}, actions?: string[], when?: RuleGroup}` | One rule; `actions` left out means everything. |
| `RuleBuilderEffect` | `{id, label, icon}` | The first is the one that lets; any other stops (and offers refusal words). |
| `RuleBuilderWhoKind` | `{kind, label, icon?, field?, options?, add?: {label, placeholder, onAdd(name)}}` | A kind of who; one with `field` keeps its chosen option's value under that key (a type, a person). |
| `RuleBuilderFact` | `{id, label, kind, options: RuleBuilderOption[]}` | What a condition may name and compare with. |
| `RuleBuilderOption` | `{value: string \| number \| boolean, label, about?}` | A typed value; conditions keep the typed value, never its key. |
| `RuleBuilderProblem` | `{index: number \| null, says}` | Why a save was refused: beside rule `index`, or above the list. |
| `ruleSays` | `(rule, {effects, whoKinds, actions, facts, operators, words?}) => string` | The rule's plain meaning ("Allow viewer to read the space, only when …"). |

## Dependencies

**Depends on:** `../coss/ui/button`, `../coss/ui/input`, `../icon` (NamedIcon), `../action-menu` (every menu), `../drag-reorder-list/SortableRows` (reorder by the `data-reorder-handle` grip), `../rule-filter` (RuleFilterChips and its builder for conditions). Appearance: Tailwind utilities over the screen-look tokens (`--border-primary`, `--glass-bg-subtle`, `--text-muted`).

**Depended on by:** `src/workspace/spaces-screen.tsx` ("Who can do what" in a space, fed by `GET /work/api/spaces/<id>/rules`).

## References (inspiration only, no code copied)

Notion People role menu (Mobbin e78d4c10-2356-4a90-9021-f3179d6435d2), Obvious role menu with a line per role (7e43776a-22eb-433a-b8a8-66c09235280a), Twenty role permissions (c9759335-0e75-4bfd-9a89-a52e5e20ea0d), Toggl Track access rights (8488b6d8-0c86-4925-8c64-d6cac7a2bfed), Plain roles (1dee496e-c015-43c4-a0ca-79c37bf40174); 21st.dev 29811 Workspace Role Select and 24929 Role Permissions Picker (no licence stated, anatomy only).

## Invariants

- Blind: no rule set, action, fact, kind of who or product name appears here.
- Never decides: the owner of the rules decides and may refuse; its words are shown as given.
- A value keeps its type through the condition builder (keys are translated both ways here).
- No free-text rule entry: typing is only a new option's name and a stopping rule's words.
