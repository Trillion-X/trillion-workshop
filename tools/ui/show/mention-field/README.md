# parts/ui/show/mention-field

The words part of every message box: plain writing with the browser's spelling help, where `@` offers the person's own people, AIs, workflows, automations and actions and drops the chosen one in as a coloured chip. The text model and key handling are ported from the documents package (`bitfield-packages/packages/documents/read-data/`) with no runtime ties.

## Files

| File | Purpose |
|------|---------|
| `inline-tokens.ts` | The text model: a mention lives in plain text as `⟦ref:<url-encoded {k,v,l}>⟧`; split, join, read mentions back, read as `@name`. Zero DOM. |
| `inline-chip-dom.ts` | Draws stored text into an editable element with each token as a chip, and reads the element back to the same text. |
| `composer-key-action.ts` | What a keystroke means: Enter sends, Shift+Enter is a new line, the open picker owns Arrow/Enter/Tab/Escape, an input method keeps Enter. |
| `MentionField.tsx` | The field: a `plaintext-only` editable with the shared `@` picker (`../mention-picker`, grouped by kind, with its kind row) above it. |
| `index.ts` | Public exports (declared public in `parts/ui/part.json`). |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `MentionField` | `({ value, onValueChange, onSubmit, ariaLabel, placeholder?, disabled?, candidates?, kinds?, pickerLabel?, onQuery? }) => ReactElement` | The field. `value` is plain text with tokens; `onQuery` hears what is typed after `@` for a caller that searches live. |
| `MentionCandidate` | `{ kind, value, label, detail? }` | Something that can be mentioned: a DATA kind, the thing's own id, its name. |
| `MentionKind` | `{ label, icon, colour }` | How a kind looks; `colour` is a screen-look colour id (`[data-colour]`). |
| `Ref` / `Run` | `{ kind, value, label }` / text or ref run | The token's content and the split of a text. |
| `encodeRefToken` | `(ref) => string` | The token for one mention. |
| `parseInlineRuns` / `runsToText` | `(text) => Run[]` / `(runs) => string` | Exact inverses; a malformed token stays as its characters. |
| `refsIn` | `(text) => Ref[]` | Every mention, once each, in order. |
| `plainWords` | `(text) => string` | The text as a person reads it (`@name`). |
| `composerKeyAction` | `({ key, shiftKey, composing, overlayOpen }) => 'defer' \| 'submit' \| 'dismiss' \| 'type'` | The one keystroke decision. |

## Invariants

- Nothing here names a kind: candidates, labels, icons and colours are the caller's DATA.
- Pasted formatting never enters (`plaintext-only`); spelling correction stays on.
- A chip is atomic and carries its mention on `data-ref-*`, so reading the field back re-encodes exactly its token.

## Dependencies

**Depends on:** `../container`, `../mention-picker`, `react`; look in `parts/screen-look/show/mention-field.css`.
**Depended on by:** `src/workspace/mentions.ts`, `tools/messages-screen/web/src/workspace/messages-screen.tsx`.
