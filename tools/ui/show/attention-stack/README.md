# attention-stack

What only the person can do, drawn first and loudest: a count, then each waiting kind as a group with its own count, icon, first few things and one action per thing.

## Files

| File | Purpose |
|---|---|
| `AttentionStack.tsx` | The stack: the total count, the groups in the caller's order, a filled button per thing (the shared button's own working/done/try-again face, with a refusal beside it), a sound player when a thing has a clip, an inline form through the shared hover form, and "Show N more" for a group's rest. |
| `index.ts` | The public entry (declared in `ui/part.json`). |

## Key types

| Type | Shape | Role |
|---|---|---|
| `AttentionStackProps` | `{ title, count, groups: AttentionGroup[], words: AttentionWords, go?: AttentionAction, shown? }` | Everything shown is the caller's DATA; `go` is one press beside the count that goes through everything waiting. |
| `AttentionGroup` | `{ id, title, icon?, count, things: AttentionThing[], all?: AttentionAction }` | One waiting kind; `all` is one button for the whole group (such as "Seen them"). |
| `AttentionThing` | `{ id, title, detail?, meta?, clip?, action: AttentionAction, form?: HoverForm }` | One thing; with `form` its button opens that form in place. |
| `AttentionAction` | `{ label, run? }` | A press; a returned promise is the button's work. |
| `AttentionWords` | `{ working, done, more, fewer }` | The stack's own words, from the caller. |

## Dependencies

**Depends on:** `coss/ui/button` (and `button/press-work`), `coss/ui/badge`, `icon`, `audio-clip-player`, `record-views/hover-form`, `safe-error-card`; look in `screen-look/show/attention-stack.css`.

**Depended on by:** Trillion Home (`src/workspace/needs-you.tsx`).

## Invariants

1. No product words: titles, counts, labels and things are the caller's DATA.
2. Nothing waiting means the caller draws nothing; the part never shows an empty box.
3. A group never cuts things off without saying how many are left.
4. A group's count may be more than the things it was handed; its "more" control says only how many more it can show, and `go` is the way through all of them.
