# completion-ring/

The Amie-style task completion circle: an 18px ring that previews a check on hover, fills with the success token when done, and toggles via one callback.

## Files

| File | Purpose |
|------|---------|
| `CompletionRing.tsx` | The ring primitive: rest ring, hover check preview, done fill, optimistic-friendly `onToggle(next)` |
| `index.ts` | Barrel export |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CompletionRing` | `({ done, onToggle, disabled?, 'aria-label'? }) => JSX` | The completion affordance every list/board surface shares |
| `CompletionRingProps` | `{ done: boolean; onToggle: (next: boolean) => void; disabled?: boolean }` | Props contract |

## Dependencies

**Depends on:** `lucide-react` (Check), `@/packages/ui/show/cn`.
**Depended on by:** `@/packages/ui` barrel; visual-database `CompleteControl` (and any future surface with completable rows).

## Invariants

- Generic — `done` boolean in, next boolean out; zero product vocabulary.
- Success color rides `--status-success` (system-green fallback); rest ring rides white-opacity tokens; the done check rides `--completion-check-color` / `--text-on-success` with white fallback so dark themes do not show a black check on green.
- Click never bubbles (lives inside clickable rows/cards).
