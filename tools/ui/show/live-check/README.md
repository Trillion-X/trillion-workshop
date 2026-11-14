# live-check

What is being checked right now and how each check stands, so a person sees a thing finish by itself instead of telling anyone they did it.

## Files

| File | Purpose |
|---|---|
| `LiveCheck.tsx` | One row per check: its mark (a turning arc while watched, a tick when done, a cross when failed), what is checked, the line under it, and the state as a pill; the rows' state said politely to assistive technology. |
| `index.ts` | The public entry (declared in `ui/part.json`). |

## Key types

| Type | Shape | Role |
|---|---|---|
| `LiveCheckProps` | `{ rows: LiveCheckRow[], label, className? }` | The checks and the section's name. |
| `LiveCheckRow` | `{ key, label, detail?, state: 'watching' \| 'done' \| 'failed', status? }` | One check; `status` is the pill's words. |

## Dependencies

**Depends on:** `icon` (`NamedIcon`); look in `screen-look/show/live-check.css`.

**Depended on by:** Trillion's waiting screen on one thing (`src/workspace/waiting-screen.tsx`).

## Invariants

1. No product words: every line and state word is the caller's.
2. States are `watching`, `done`, `failed`.
3. State changes are announced politely (aria-live), never on every redraw.
4. Reduced motion stops the turning.

## References

21st.dev "Task Steps" by ddoemonn (component 23569): pending, active and done marks with a spinner and an aria sentence. Tolaria's "AI agents ready" rows (the person's /Inspiration/Trillion Screens): name, line under it, status pill on the right.
