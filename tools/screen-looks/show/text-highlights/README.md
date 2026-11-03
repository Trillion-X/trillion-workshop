# text-highlights

Marks words on a surface (words found on the screen, the words an answer cites, a reviewer's marks) with the CSS Custom Highlight API: ranges over the surface's own text nodes in `CSS.highlights`, never `<mark>` elements, so shared components and collaborative text are never changed or re-rendered. Where the browser has no Custom Highlights the text stays plain.

## Files

| File | Purpose |
|------|---------|
| `text-highlights.ts` | `paintWords`, `paintRanges`, `rangesOf`, `clearHighlights`, `wordsToFind`, `followHighlights`. |
| `text-highlights.json` | DATA: the mark kinds and their highlight names, the shortest word looked for, the most marks per paint, elements never marked. |
| `index.ts` | Exports. |
| `../../../screen-look/show/text-highlights.css` | How each kind looks (`::highlight(...)`). |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `followHighlights` | `(root, kind, onPaint?) => { set(words), stop() }` | Keeps one kind's marks on the current words as the surface redraws (one repaint per animation frame). |
| `paintWords` | `(root, kind, words) => { painted, count }` | One paint; `painted: false` when the browser has no Custom Highlights. |
| `rangesOf` | `(root, words) => Range[]` | Where the words appear in the text under `root`, skipping editable fields and code. |

## Consumers

- `src/workspace/lists-screen.tsx`: the words typed in a list's search are marked in its rows.

## Invariants

1. Nothing is written into the surface; marks live only in `CSS.highlights`.
2. Unsupported browsers keep plain text and still get the count.
3. Kinds, limits and skipped elements are DATA.
