# parts/ui/show/run-view

One piece of work as someone watches it: the work on top as one glance card (its state as a tinted tile, its words, when it was asked, the faces of whoever is on it, its buttons), then every step taken for it as glance rows, oldest first and newest at the foot, with a row for the step still going while someone is working (told by its icon and tone; nothing spins). A step opens into its details. Every row is `listing-card`, so a run reads like every other list in Trillion, never as a paragraph.

## Files

| File | Purpose |
|------|---------|
| `RunView.tsx` | `RunView`: the work card, the step rows in a capped scrolling list that follows the newest step only for a reader already at the foot, the working row, and the detail card a step opens into. |
| `index.ts` | Public barrel. |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `RunView` | `({ run, steps, details?, working?, stepsLabel, onAction?, onOpen? }) => JSX` | Draws one run. `run`, each step, each detail and `working` are `Listing`s (the glance shape); `details` is keyed by step id. |
| `RunViewProps` | the props above | |

## Sources and licences

| Source | Taken | Licence |
|--------|-------|---------|
| 21st.dev 29318 "Agent Activity" by starc007 (https://21st.dev/@starc007/components/agent-activity) | Live stream of steps kept at the newest step, capped height that scrolls | Anatomy only, rebuilt on `listing-card`; no code copied. |
| 21st.dev 23789 "AI Tool Call" by educalvolpz (https://21st.dev/@educalvolpz/components/ai-tool-call) | A step that opens into its details, with running, done and failed states | Anatomy only, rebuilt. |

## Dependencies

**Depends on:** `container`, `listing-card` (`ListingCard`, `Listing`).
**Depended on by:** `src/workspace/job-run.tsx` (the message box and Home after Send, the AI work screen, the job screen).

## Invariants

1. Blind: no kind of work, actor, tool or state is named here; every word, icon, tone and face is the caller's.
2. Steps are drawn in the order given; a new step scrolls into view only when the reader was already at the newest.
3. A step opens only into the details given for it.
4. Nothing spins: a step still going is told by its own icon and tone; the one loading animation is `parts/ui/show/spinner`.
