# parts/ui/show/mention-picker

What `@` shows in any place a person writes: the things they can mention, grouped by kind with each kind's icon in its colour, narrowed by what they type, with a row of kinds that narrows to one kind and "All" that widens back.

## Files

| File | Purpose |
|------|---------|
| `MentionPicker.tsx` | `MentionPicker`: the kind row and the grouped list. |
| `pick-mentions.ts` | `pickMentions` (the one rule for what shows) and `mentionKindsAmong` (the kind row's choices). Zero DOM, zero React. |
| `index.ts` | Public exports (declared public in `parts/ui/part.json`). |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `MentionPicker` | `({ candidates, kinds?, query, kind, onKindChange, highlighted, onHighlight, onChoose, label, allLabel?, id? }) => ReactElement` | The picker. Controlled: the field that owns the caret holds the typed words, the highlighted row and the chosen kind, so focus never leaves the words. |
| `pickMentions` | `(candidates, kinds, query, kind) => MentionOption[]` | What shows: options whose name or line holds the words (or whose kind's name starts with them), of `kind` or every kind, grouped by kind in first-appearance order; at most 12 across kinds, 30 of one kind. The highlighted index counts these rows. |
| `mentionKindsAmong` | `(candidates, kinds, query) => string[]` | The kinds the words leave, for the kind row. |
| `MentionOption` | `{ kind, value, label, detail? }` | One thing that can be mentioned (the same shape as `../mention-field` `MentionCandidate`). |

## Invariants

- Nothing here names a kind: candidates and looks (`kinds`: `{ label, icon, colour }` by kind, `../record-chip` `RecordChipKinds`) are the caller's DATA; an unknown kind draws under its own key with the at-sign mark.
- The rows `pickMentions` answers are exactly the rows drawn, so a highlighted index never points at a hidden row.
- Pressing a row or a kind holds mouse down, so the field keeps focus and its caret.

## Dependencies

**Depends on:** `../button`, `../container`, `../icon`, `../text`, `../record-chip` (types), `react`; look in `parts/screen-look/show/mention-picker.css`.
**Depended on by:** `../mention-field` (`MentionField`'s `@` picker, so every ask bar and composer), the document editor's inline `@` (`parts/documents`, wired by its own builder).
