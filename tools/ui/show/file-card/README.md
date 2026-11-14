# file-card

Everything about one file under its preview, wherever the file shows: facts, what the person can do with it, the next step, who is in it, what was said and by whom, and files beside it.

## Files

| File | Purpose |
|------|---------|
| FileCard.tsx | The blind card part, the page-wide card source (`provideFileCards`) and `FileCardFor`, which reads and draws the card for one file |
| index.ts | Exports |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `FileCardSubject` | `{ id, title, url?, type?, poster? }` | The file as a preview knows it |
| `FileCardView` | `{ facts, actions, lead, about, people, words, related, suggestions, said }` | Everything one card draws; every word arrives here; `about` is the file as menus know it, so the ⋯ offers every row the page has for it |
| `FileCardSource` | `read(subject)`, `act(subject, id)`, `open(subject, { related?, at? })`, `reorder?`, `subscribe?` | What the page installs; reads a card and does its actions |
| `provideFileCards` | `(source \| null) => void` | Installs the page's source (shared through globalThis across React roots) |
| `FileCardFor` | `({ subject, full? })` | Draws the card for a file, or nothing until the source answers |
| `FileCard` | `({ subject, view, source, full? })` | Draws one view |

## Dependencies

**Depends on:** `coss/ui/button` (Button with pending/done/error faces), `icon/NamedIcon`, `action-menu/ActionMenu` (the ⋯ menu, opens on hover, rows can be dragged), `fact-chips/FactChips`, `person-tag/PersonTag`; look in `screen-look/show/file-card.css`.

**Depended on by:** `hover-preview/HoverPreview` (under every file's screen), `src/workspace/file-screen.tsx` (a file's own tab), `src/workspace/file-card.ts` (the signed-in page's source).

## Invariants

- Names no file kind, tool or address; actions are only the ones the source offered for this file.
- With no source installed, nothing is drawn.
