# info-hint

The small info icon beside a heading. Hovering, focusing or pressing it opens an animated popover with the words that used to sit under the heading as helper text, so pages show their heading and their work, and the explanation is one hover away.

## Files

| File | Purpose |
|------|---------|
| `InfoHint.tsx` | `InfoHint`: a ghost icon button (the shared coss Button) that opens the shared coss Popover on hover (120 ms), focus or press, with an optional title and the words. |
| `index.ts` | The one import point. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `InfoHint` | `({ label, text, title?, side?, align? }) => JSX` | The icon and its popover. `label` is the button's accessible name. `side` defaults to `top`: the popover opens on hover, so it never sits under the pointer. |
| `InfoHintProps` | `{ label: string; text: string; title?: string; side?: 'top'\|'bottom'\|'left'\|'right'; align?: 'start'\|'center'\|'end' }` | Every word is the caller's. |

## Invariants

- Blind: nothing here names a page or feature.
- Keyboard reachable: a real button, Escape closes.
- Appearance is the coss popover tokens; the popup carries `data-slot="info-hint-content"` for tests.

## References

- 21st.dev 403 "Popover" (originui, tooltip-like popover): https://21st.dev/@originui/components/popover

## Dependencies

**Depends on:** `../coss/ui/popover`, `../coss/ui/button`, `../icon` (NamedIcon).

**Depended on by:** `parts/ui/show/collection-header` (its `info` prop), and through it `src/workspace/spaces-screen.tsx`.
