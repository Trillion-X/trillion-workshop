# steps-checklist

Steps a person does by hand, one row each, in order, under a count and a thin bar of how many they ticked: the words of each step, and beside or under them whatever the caller puts there (a value to copy, a saved login shown in place). Ticking only keeps the person's place; whether the whole thing is done is decided elsewhere.

## Files

| File | Purpose |
|---|---|
| `StepsChecklist.tsx` | The checklist: count and bar, one bordered list with a hairline between rows, each row the shared Checkbox, the step's words, its `beside` and `under`; ticks kept in session storage under `keptAt`. |
| `index.ts` | The public entry (declared in `ui/part.json`). |

## Key types

| Type | Shape | Role |
|---|---|---|
| `StepsChecklistProps` | `{ steps: ChecklistStep[], words: StepsChecklistWords, keptAt?, className? }` | Everything shown is the caller's. |
| `ChecklistStep` | `{ key, label: ReactNode, beside?: ReactNode, under?: ReactNode }` | One step; `beside` sits on the right (wraps under the words on a narrow width), `under` below the words. |
| `StepsChecklistWords` | `{ count: '{done} of {total}…', tick: '…{n}' }` | The count's words and each mark's name. |

## Dependencies

**Depends on:** `coss/ui/checkbox`; look in `screen-look/show/steps-checklist.css`.

**Depended on by:** Trillion's waiting screen on one thing (`src/workspace/waiting-screen.tsx`), the screen the hold locks on.

## Invariants

1. No product words: every step, extra and count word is the caller's.
2. A tick is kept on this device under `keptAt` (session storage), so a reload keeps the person's place.
3. Each mark is the shared Checkbox, named by the caller's `tick` words with the step's number.
4. Reduced motion draws the tick without movement.

## References

21st.dev "Onboarding Checklist" by ssychui (component 30552): count, thin bar, filled round mark, struck-through done step. Mobbin: DoorDash Merchant numbered steps (cb2e2006), Xero set-up steps in one bordered box (42576734), Supabase and Klaviyo copyable values (2c39a77f, 38834bba).
