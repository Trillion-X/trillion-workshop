# swipe-deck

A stack of cards decided one at a time, ported from the 21st.dev "Swipe Deck" (ddoemonn, registry component 23568): drag or throw the top card left or right, use the arrow keys or the buttons under it, and Undo brings the last one back.

## Files

| File | Purpose |
|------|---------|
| `SwipeDeck.tsx` | `SwipeDeck` (the drawn deck) and `useSwipeDeck` (its state). The next cards show under the top one, lower and smaller (`PEEK_STEP`, `PEEK_SHRINK`) with an elevation shadow so the deck reads as a stack at any width; the dragged card tilts, and the side it leans toward shows its word as a tilted stamp and a wash of that side's colour that deepens toward the point where letting go decides it. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `SwipeDeck<T>` | `({items, itemKey, itemLabel, children, onDecide?, onUndo?, onOpen?, onRestart?, disabled?, label?, leftLabel?, rightLabel?, leftIcon?, rightIcon?, leftTone?, rightTone?, undoLabel?, emptyLabel?, againLabel?, height?, threshold?, steps?, peek?}) => JSX` | The deck. The caller draws each card and says what each side means and which look colour it shows. |
| `useSwipeDeck` | `({count, threshold?, steps?, flick?, onDecide?, onUndo?, onOpen?, disabled?}) => {index, decide, undo, restart, open, report, release, deckProps, ...}` | The deck's decisions, undo and drag intent, for a caller drawing its own cards. |
| `SwipeChoice` | `'left' \| 'right'` | A decision. |
| `SwipeTone` | `'success' \| 'destructive' \| 'warning' \| 'info' \| 'primary' \| 'muted'` | The look's colour a side shows (the status tones the look gives). |

## Dependencies

**Depends on:** `framer-motion`, `../coss/ui/button`, `../icon`.

**Depended on by:** `../record-views/designs/swipe-design.tsx` (the Swipe view any list can pick, whose tones come from its row's `left_tone` / `right_tone` in `designed-views.json`).

## Invariants

- Blind: no kind of item, word or meaning is named here.
- A press that did not drag opens the card; a drag never opens it.
- Reduced motion skips every animation and keeps every decision.
