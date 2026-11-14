# parts/ui/show/record-chip

The one live chip for a mentioned thing of any kind: its kind's icon in its kind's colour, then its name; pressing it opens the thing.

## Files

| File | Purpose |
|------|---------|
| `RecordChip.tsx` | `RecordChip` (the chip), `RecordChipProvider` (kinds' looks and where things open, handed down once) and `MentionWords` (words drawn with their mentions as chips). |
| `mention-runs.ts` | `mentionRuns` and `keptMentions`: the one rule for finding a kept message's mentions in its words. Zero DOM, zero React. |
| `index.ts` | Public exports (declared public in `parts/ui/part.json`). |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `RecordChip` | `({ kind, value, label, icon?, colour?, onOpen?, href?, still? }) => ReactElement` | The chip. `onOpen` opens in place (a button); `href` is a real link (a new tab works), taken in place by the provider's `open`; with neither, or with `still` (a chip inside words being written, as in the composer's box), it is drawn still. Icon and colour default to the kind's look. |
| `RecordChipProvider` | `({ kinds?, hrefOf?, open?, children })` | Hands every chip beneath it `kinds` (`{ [kind]: { label, icon, colour } }`), `hrefOf(kind, value)` (the address a thing opens at, or null) and `open(href)` (opens in place; false lets the browser follow the link). |
| `MentionWords` | `({ text, mentions? }) => ReactElement` | Words with their mentions drawn as chips: plain words with `mentions` kept beside them (a kept message), or words holding `⟦ref:…⟧` tokens (`parts/documents/read-data/inline-tokens.ts`, the one owner of the token model) when none are given. Message bubbles and space posts use it. |
| `mentionRuns` | `(text, mentions?) => MentionRun[]` | Words kept as a person reads them (`@Jo, look`) split into text and the mentions kept beside them: each at its first free `@label`, longest name first; joining gives the words back exactly. The one owner of this rule (the chat part's `ChatMention` re-exports it). |
| `MentionRun` | `{ type: 'text', text } \| { type: 'mention', kind, value, label }` | One run of `mentionRuns`. |
| `keptMentions` | `(listed: unknown) => KeptMention[]` | The well-formed mentions of a list read from stored JSON (a space message's `body.mentions`). |
| `KeptMention` | `{ kind, value, label }` | A mention as a kept message carries it. |
| `RecordChipKind` / `RecordChipKinds` | `{ label, icon, colour }` / map by kind | How a kind looks; `colour` is a screen-look colour id (`[data-colour]`). |
| `RecordChipSetting` | `{ kinds?, hrefOf?, open? }` | What the provider holds. |

## Usage

```tsx
<RecordChipProvider kinds={mentionKinds} hrefOf={addressOfMention} open={openInWorkspace}>
  <MentionWords text={message.text} mentions={message.mentions} />
  <RecordChip kind="decision" value="case:launch" label="Launch pricing" />
</RecordChipProvider>
```

## Invariants

- Nothing here names a kind: looks come from props or the provider's DATA; an unknown kind draws with the at-sign mark and the neutral tone.
- A chip that opens nothing is never a control: it is drawn still (`data-still`).
- Appearance is `parts/screen-look/show/record-chip.css` (`record-chip*`, `[data-colour]`), the same colour ids the message field's chips carry while writing.

## Dependencies

**Depends on:** `../icon` (`NamedIcon`), `parts/documents/read-data/inline-tokens.ts` (`parseInlineRuns`), `react`; look in `parts/screen-look/show/record-chip.css`.
**Depended on by:** `../mention-picker` (kind marks), `../coss/thread` (space posts), `src/workspace/mentions.ts` (the workspace's provider), the document editor's inline tokens (`parts/documents`, wired by its own builder).
