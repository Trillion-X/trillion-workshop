# run-card

One run of a tool or a piece of work, drawn as a card: its title and what it was for, its state in the person's words with its tone, when it was asked, what it returned as labelled fields, and a safe error with a retry. Anatomy follows 21st.dev's Agent Elements "Tool Group" (id 12423): a sentence-case state, a quiet line under the title, the time at the right, and no avatar, since a run is a thing and is never given a face.

## Files

| File | Purpose |
|------|---------|
| `RunCard.tsx` | The card: title and `detail` line, the state badge (humanized by status-vocabulary `statusView`), the time, `OutputFieldList` rows, and `SafeErrorCard` for an error. |
| `index.ts` | Barrel: the one import point for `RunCard` and `RunCardProps`. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `RunCard` | `(props: RunCardProps) => JSX.Element` | Draws one run. |
| `RunCardProps` | `{ title: string; detail?: string \| null; requestedAtLabel?: string; status?: string \| null; statusOverrides?: StatusOverrides; outputs?: OutputField[]; errorMessage?: string \| null; onRetry?: () => void; children?: ReactNode }` | The run as data. `status` is the raw key; `statusOverrides` maps it to `{ label, tone }` (DATA, never a branch here). What a run returned in full is drawn beside the card by `SchemaValueView`, not inside it. |

## Dependencies

**Depends on:** `status-vocabulary` (`statusView`, `StatusOverrides`), `output-field-list` (`OutputFieldList`, `OutputField`), `safe-error-card` (`SafeErrorCard`), `badge`, `container`, `text`.

**Depended on by:** `src/workspace/workshop-screen.tsx` (the run screen at `/workshop/runs/<task>`, also drawn in the in-chat view through `src/workspace/screen-view.tsx`).
