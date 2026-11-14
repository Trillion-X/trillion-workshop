# ui/show/keyboard-shortcuts/

A domain-blind keyboard-shortcuts cheat-sheet modal — given a `{ heading, rows: { label, keys }[] }[]` catalog, it renders the canonical grouped reference (Figma/Framer/Relume style) with keycaps.

## Files

| File | Purpose |
|------|---------|
| `ShortcutSheet.tsx` | The blind cheat-sheet component: composes `Modal` (centered dialog + Escape/backdrop/× close) + a responsive multi-column grid of groups; each row = a human `label` on the left and its `keys` as `Kbd` keycaps on the right (one `<Kbd>` per token, in order). Knows nothing about what any shortcut DOES — it receives only `{ heading, label, keys }` strings (the ui-stays-blind catalog pattern). The owner package supplies the catalog DATA and owns the real key handlers. |
| `ShortcutSheet.test.tsx` | Vitest: closed → null (zero DOM); open renders the title + every group heading + every row label; one `<kbd>` per key token in order; the deletion test — renders an arbitrary catalog the component never knew about. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `ShortcutRow` | `{ label: string; keys: readonly string[] }` | One shortcut — a label + its display key tokens (e.g. `['⌘','D']`). |
| `ShortcutGroup` | `{ heading: string; rows: readonly ShortcutRow[] }` | A titled group of shortcuts (e.g. "Edit"). |
| `ShortcutSheet` | `({ open, onClose, title?, groups }) => JSX` | The blind cheat-sheet modal. `title` defaults to "Keyboard shortcuts". `Modal` owns all close affordances. |

## Dependencies

**Depends on:** `@/packages/ui/show/modal` (Modal), `@/packages/ui/show/text` (Text), `@/packages/ui/show/kbd` (Kbd).

**Depended on by:** the `ui` barrel (`@/packages/ui`), and any package that wants a "?" cheat sheet — e.g. `group`/`vision-board` (board-shortcuts.ts catalog + "?" handler in GroupBoardPanel).
