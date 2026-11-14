# style-choices

One choice among visual presets, each card showing a sample of its own result (caption styles, text looks, themes): a card radio group with roving arrow keys.

## Files

| File | Purpose |
|------|---------|
| `StyleChoices.tsx` | The React control. Controlled by `value` + `onChange`; each card is one radio; arrow keys move the choice and the focus. |
| `index.ts` | The one import point. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `StyleChoices` | `({ items, value?, label, onChange }) => JSX` | Draws the cards; `onChange(id)` on a press or an arrow key. |
| `StyleChoice` | `{ id, label, sample?: string \| SampleRun[], sampleStyle?: CSSProperties }` | One preset: `sample` is what its card shows (default "Aa"), `sampleStyle` the typography and colours it previews. |
| `SampleRun` | `{ text, style?: CSSProperties }` | A run of sample text with its own look (one word lit up in a caption sample). |
| `StyleChoicesProps` | the props above | For callers that build them. |

## Invariants

- Nothing is kept here: the chosen id belongs to the caller.
- A card's accessible name is its label, never its sample.

## Dependencies

**Depends on:** `../coss/ui/button`.

**Depended on by:** `../coss/dom-controls.tsx` (`mountStyleChoices`, the same control for pages that mount into an element), `src/workspace/media-edit/captions-panel.tsx` (caption styles in the media editor).
