# delight-moment

Plays one small good moment low on the screen: a turning mark, a ring of sparks and one line of words, then fades by itself. Everything it shows is the caller's DATA.

| File | Purpose |
|---|---|
| `DelightMoment.tsx` | `DelightMoment` (one moment) and `DelightMomentLayer` (the fixed place moments play in). |

## Key types

| Type | Shape | Role |
|---|---|---|
| `DelightMotion` | `{ card: { initial?, animate, transition }, mark?: { animate, transition }, sparks?, spark_distance?, spark_duration? }` | How a moment moves (framer-motion targets). |
| `DelightMomentProps` | `{ mark, words, motion, onDone }` | One moment. |
| `DelightMomentLayer` | `({ moment \| null, onDone })` | Draws nothing while no moment plays. |

Appearance: `parts/screen-look/show/delight-moment.css`. Never takes focus, never blocks a click, never plays a sound; reduced motion shows only the words.

## Dependencies

**Depends on:** `framer-motion`.

**Depended on by:** `delight-moments` (`show/mount-delight-moments.tsx`).
