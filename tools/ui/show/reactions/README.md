# parts/ui/show/reactions

Reactions on a thing, drawn the same everywhere: a row of chips (glyph and count, lit when one is yours, who gave it on hover) and a smile button that opens the offered reactions plus a field for your own emoji or an https picture or GIF.

## Files

| File | Purpose |
| --- | --- |
| `ReactionRow.tsx` | `ReactionRow` (the chips and the picker) and `ReactionGlyph` (an emoji as text, an https address as a picture); every press is the button's own work, so it shows pending, done or the failure in itself |
| `README.md` | This file |

## Key Types / Functions

| Type | Signature / Shape | Role |
| --- | --- | --- |
| `Reaction` | `{ symbol, glyph, label, count, yours, by? }` | One kept reaction as the store folds it (`src/responses.mjs foldReactions`) |
| `OfferedReaction` | `{ symbol, glyph, label }` | One palette entry (`src/reactions.json`) |
| `ReactionChoice` | `{ on: boolean, symbol?, glyph? }` | What a press asks for: a palette symbol, or your own glyph |
| `ReactionWords` | `{ add, own, ownPlaceholder, ownAdd }` | The visible words, replaceable by the caller |
| `ReactionRow` | `({ reactions, palette, onReact, words?, compact?, only?: 'given' \| 'add' }) => JSX` | The row; `onReact` returns the work's promise; `only` draws just the chips or just the way to add one (a chat's bubble and its tools) |
| `ReactionGlyph` | `({ glyph, label }) => JSX` | Draws one glyph |

## Dependencies

**Depends on:** `../coss/ui/button`, `../coss/ui/popover`, `../coss/ui/input`, `lucide-react`; look in `parts/screen-look/show/reactions.css` (`.reaction-*`).

**Depended on by:** `../coss/thread.tsx` (every post and reply), `../responses/SelectionResponses.tsx` (the glyphs in the selection bar), `../chat/ChatThread.tsx` (chips on a bubble, the picker among its tools).
