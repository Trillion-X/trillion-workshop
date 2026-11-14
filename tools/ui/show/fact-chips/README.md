# fact-chips

Small chips that say what an item is at a glance (length, language, projects, tags, where it is kept). Each opens on hover or focus into a popover with the details behind it and the actions that change it.

## Files

| File | Purpose |
|------|---------|
| `FactChips.tsx` | `FactChips` and `formatFactValue`: chips chosen and ordered by field DATA, values formatted by field kind, hover popovers with details, a tag editor and actions. |
| `mount-fact-chips.tsx` | `mountFactChips`: mounts the chips into a DOM host for non-React pages. |
| `index.ts` | Public exports. |
| `FactChips.test.tsx` | DATA order, per-kind formatting, hidden empty facts, tag add/remove, actions reported to the caller, and nested choices behind an action. |
| `provenance.json` | References and adaptations. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `FactChips` | `(props: FactChipsProps) => JSX.Element \| null` | Renders the chip row. |
| `FactChipsProps` | `{ fields: FactField[], facts: Record<string, unknown>, valueLabels?, valueIcons?, label?, onAction?(actionId, fieldId, value?), choicesFor?(actionId, fieldId) }` | Field descriptors, the item's values, names and icons for individual values, and the caller's action handler. An action `choicesFor` answers opens those choices as a hover menu (the card stays open while it is open); the chosen one reaches `onAction` as `value`. |
| `FactField` | `{ id, label, kind, unit?, icon?, values?, chip?: FactChipPlacement }` | The same descriptor a Library filter reads. |
| `FactChipPlacement` | `{ order, details?: string[], actions?: FactChipAction[], edit?: 'tags' }` | Makes a field a chip: its place, the fields listed when it opens, its actions, whether its values can be added and removed. |
| `formatFactValue` | `(field, value, valueLabels?) => string` | A value as a person reads it, by `kind` (duration, number, bytes, date, choice, tags, text). |
| `mountFactChips` | `(host: HTMLElement, props: FactChipsProps) => () => void` | DOM mount; re-renders in place; returns unmount. |

## Invariants

- Which chips appear and in what order is DATA; the component names no field.
- A field with no value draws no chip, unless it offers actions or an editor (so its first value can be added).
- The component never writes; `onAction` hands every change to the caller's owner.
- Appearance lives in `screen-look/show/fact-chips.css`.

## Dependencies

**Depends on:** `ui/show/icon` (`NamedIcon`), `ui/show/coss/ui/popover` (Base UI popover, hover-open), `ui/show/coss/workspace-controls` (`mountSharedContent`), `lucide-react`.
**Depended on by:** `media-workspace` recording view (chips under the player, fields from `library-fact-fields.json`).

## In Trillion

Ported unchanged from the Bitfield package `packages/ui/show/fact-chips` (every file byte for byte except this section and the example labels in its test; `scripts/port-sources.json` lists it). Its appearance is `parts/screen-look/show/fact-chips.css`, loaded with every workspace look (`scripts/workspace-looks.json`). The package's own test, `FactChips.test.tsx`, is run in a real browser (with neutral example labels) by `test/fact-chips-package-test.test.mjs`, which hands it the small part of vitest and Testing Library it uses. In Trillion it is drawn by `parts/ui/show/listing-card` (a listing's `factChips`), so any glance card or row can carry field chips that open into their details.
