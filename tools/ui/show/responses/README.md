# parts/ui/show/responses

Answer any words on any screen where they are: selecting words opens a bar with Comment and, where the thing takes reactions, its reactions; Comment opens a box quoting the words and sends what is written about exactly them. Which thing the words belong to, and who reads the answer, is the host's (`src/workspace/responses.tsx`).

## Files

| File | Purpose |
| --- | --- |
| `SelectionResponses.tsx` | The layer: watches the selection, asks the host's `targetOf` what thing it is in, draws the bar and the comment box in a coss Popover anchored to the selected words; opens nothing while a show rule hides the control `RESPONSES_CONTROL` (`selection.responses`) |
| `ElementResponses.tsx` | Shows the same reaction and comment actions beside an element picked by the shared pointer |
| `selection-comment-request.ts` | Dispatches a DATA-named selection action with a retained range; an editor can open the existing comment thread from its own toolbar |
| `text-part.ts` | Some words of a thing as a `text-range` part (the W3C TextQuote and TextPosition selectors): make one from a selection, find it again after the text changed |
| `README.md` | This file |

## Key Types / Functions

| Type | Signature / Shape | Role |
| --- | --- | --- |
| `SelectionTarget` | `{ root: Element, audience: string, comment(part, text, replyTo?), readComments?, react?, readReactions? }` | What the host says about the thing under the words or picked element |
| `SelectionResponses` | `({ targetOf, palette?, words? }) => JSX` | The layer, mounted once per page |
| `RESPONSES_CONTROL` | `'selection.responses'` | The control the bar is decided under (show-rules `control`) |
| `TextPart` | `{ kind: 'text-range', quote, prefix, suffix, start, end }` | The part every store keeps under `part` (`src/responses.mjs partFrom`) |
| `textPartOf` | `(root: Element, range: Range) => TextPart \| null` | The part a selection picks inside `root` |
| `findTextPart` | `(whole: string, part) => [start, end] \| null` | Where kept words are now: the kept place, else with their surroundings, else alone |

## Anchor model

Every answer points at `{ record, part? }`: `record` is the thing's own reference (a space item id, `file:<identity>`, a decision case id, `page:<address>`), and `part`, when the answer is about a piece of it, is a plain object with a `kind` (`text-range` here; an element picked with `point-at-anything`, a moment, a point are other kinds). The same shape is what an annotation sent to an AI carries.

An addressed record may mark nested content with `data-response-element`. The host then counts text inside that member and adds its stable identity to `part.element`, for both writes and reads. Write supplies its scene address and block identity; shared rooms retain their existing membership and audience owner. Contenteditable text continues to use its own formatting bar. Its DATA action requests `trillion:selection-comment` with a cloned range; the shared response layer checks locks, show rules and both selected endpoints before opening its existing thread. No separate document-comment store is created.

## Dependencies

**Depends on:** `../coss/ui/popover`, `../coss/ui/button`, `../coss/ui/textarea`, `../reactions/ReactionRow`; look in `parts/screen-look/show/reactions.css` (`.selection-responses*`).

**Depended on by:** `src/workspace/responses.tsx` (the workspace host), and any part that keeps or finds words of a thing.
