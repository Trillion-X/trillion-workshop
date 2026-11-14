# rich-text-toolbar/

A blind, DATA-driven formatting toolbar for any contentEditable rich-text surface (pairs with `rich-text-editor`).

## Files

| File | Purpose |
|------|---------|
| `RichTextToolbar.tsx` | The toolbar component + `FormatCommand` type + `DEFAULT_FORMAT_COMMANDS`. |
| `RichTextToolbar.test.tsx` | Asserts the toolbar renders exactly one control per command (DATA-driven), incl. a custom set. |
| `index.ts` | Barrel re-export. |

## Key Types / Functions

| Type / Export | Signature / Shape | Role |
|---------------|-------------------|------|
| `FormatCommand` | `{ id; label; icon; command; value?; promptFor? }` | Self-describing control: an icon + the `execCommand` it runs against the focused editable selection. `value` is a static arg (`formatBlock`→`h3`); `promptFor` prompts the user (link URL). |
| `DEFAULT_FORMAT_COMMANDS` | `ReadonlyArray<FormatCommand>` | bold / italic / heading / bulleted list / numbered list / link. Overridable. |
| `RichTextToolbar` | `({ commands? }: RichTextToolbarProps) => JSX` | Renders one ghost icon `Button` per command. Fires on pointer-DOWN with `preventDefault` so the editor keeps focus/selection (a click would blur it). |

## Dependencies

**Depends on:** `@/packages/ui/show/button` (Button), `@/packages/ui/show/container` (Container), `@/packages/ui/show/icon` (Icon), `lucide-react` (icons).
**Depended on by:** `@/packages/ui` barrel; `@/packages/group/show/item-renderers` (rich-note edit mode).

## Why This Design?

Adding a format = ONE data row in the command list, ZERO toolbar code (L069/L090). The toolbar never branches on which command it is — it maps the DATA list to buttons and dispatches `document.execCommand`, the standard (and only) universally-supported contentEditable formatting mechanism. Zero domain vocabulary — pure text-formatting Physics, reusable by any editor.
