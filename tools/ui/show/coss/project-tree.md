# Shared project tree

`mountProjectTree(host, options)` composes the pinned MIT Coss Button, Checkbox,
Input and Menu sources. Appearance belongs to `screen-look/show/coss-workspace.css`.
Consumers supply the hierarchy, records, management callbacks and selection.

The returned handle provides `selected()`, `setSelected(ids)` and `destroy()`.
`setSelected` applies a saved selection without firing `onSelectionChange`.
It preserves the mounted tree, search query, expanded branches and keyboard focus.
Unknown and duplicate IDs are removed; single-selection mode retains one ID.
User clicks and keyboard selection still call `onSelectionChange`.

This separation lets Undo/Redo, incoming saved changes and server reconciliation
paint the current selection without creating another save or resetting the tree.
The adapter does not persist changes or decide undo policy.

Tests: `__tests__/project-tree.test.tsx`; consumer interaction proof:
`media-workspace/tests/organization-history-browser.test.mjs` and
`media-workspace/tests/live-organization-history.browser.test.mjs`.

Source and visual contract: `ui/plans/2026-09-18-expansion-project-tree/`.
