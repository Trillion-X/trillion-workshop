# catch-up

Whether every copy of the person's things is in step: one small mark, the whole picture of their devices, and the view that settles a record kept as two versions because two copies changed it apart. Every state, word, tone, icon, rank and action is the caller's DATA; nothing here names a state, a device or a kind of record.

## Files

| File | Purpose |
|------|---------|
| `catch-up.ts` | The page's one registry of catch-up sources (kept on `globalThis`, like menu rows and show rules), the summary every surface reads (`catchUpView`: the highest-ranking state leads, an old fact turns into its `ages` state, records kept apart lead when their state outranks every fact), words filling, actions and settling, and the React hooks. |
| `CatchUpMark.tsx` | The small mark: a tinted dot that breathes while work goes on or a ring filling to a measured percent, with the leading state's words (`form: pill`) or its icon (`form: icon`). Draws nothing when the leading state is quiet unless `always`. Pressed, it opens `CatchUpPanel` in a popover. A change of state is announced once to screen readers. |
| `CatchUpPanel.tsx` | The whole picture: a head with the leading state, its detail and the actions its fact offers; every device as a shared ListingCard row (state words, when it last caught up, what waits, a ring only when measured); every record kept as two versions, opening `TwoVersions` in place. |
| `TwoVersions.tsx` | Any record kept as two or more versions, field by field in columns (stacked on a phone by container query), picking per field; Keep one version, Keep both, and Keep my picks once the picks are mixed. Long single texts show a line-by-line difference (lazy DiffView). Every button shows its own pending, done or Try again. |
| `index.ts` | The barrel export (listed in `parts/ui/part.json` public). |
| `README.md` | This file. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `CatchUpFact` | `{ id, state, title?, kind?, waiting?, done?, total?, at?, here?, can? }` | One thing a source keeps a copy of; `can` lists the actions its keeper can do for it here. |
| `KeptSide` / `KeptApart` | `{ id, from, keep?, at?, value, current? }` / `{ id, thing: { kind, id, title }, sides }` | A record kept as two versions. |
| `Settle` | `{ keep: 'one', side } \| { keep: 'both' } \| { keep: 'merged', value }` | How versions are settled. |
| `CatchUpSource` | `{ read(), subscribe(listener), act?(action, fact), settle?(apart, settle) }` | What a source provides. |
| `CatchUpWords` | `{ states, ages?, actions?, kinds?, apart_state?, words }` | The DATA everything is drawn from. |
| `ShownFact` | `CatchUpFact & { source, key, row, words, offers }` | A fact as drawn; `offers` = the state's actions its keeper can do. |
| `CatchUpView` | `{ lead, state, row, label, count, percent, facts, apart }` | The whole picture. |
| `catchUpView(reports, words, now)` | `→ CatchUpView` | The one summary. |
| `stateRow`, `fillWords`, `stateNow`, `plainWords` | pure helpers | A state's DATA row, its words for a count and percent, a fact's state after its age. |
| `provideCatchUpSource(id, source \| null)` | `→ void` | Adds, replaces or removes a source. |
| `provideCatchUpWords(words \| null)` | `→ void` | Installs the page's words for parts drawn without them. |
| `catchUpReports()`, `onCatchUpChange(listener)` | registry reads | Every source's report; hears any change. |
| `catchUpAct(action, fact)`, `settleKeptApart(apart, settle)` | `→ Promise` | Hands an action or a settle to the fact's own source. |
| `useCatchUp(words)`, `useCatchUpWords()` | hooks | The view, re-read on change and each minute; the installed words. |
| `CatchUpMark`, `CatchUpDot`, `CatchUpPanel`, `TwoVersions`, `fieldsOf`, `mergedValue` | components and helpers | Drawing. |

## Dependencies

**Depends on:** `ui` Button (press work), Container, Text, NamedIcon/resolveNamedIcon, IconTile, ListingCard, relative-time, diff-view, coss Popover; `screen-look/show/catch-up.css` for appearance.

**Depended on by:** `src/workspace/catch-up.tsx` (the page's sources, screens and menu rows), `parts/screen-arrangement/show/ContainerHeader.tsx` (the mark in every pane's ⋯ menu).

## Provenance and licences

- The pill: 21st.dev diceui "Status" (component 25395, MIT), adapted to the look's tokens.
- The refresh lifecycle anatomy: 21st.dev "Data Refresh State" (29369), anatomy only, no code taken.
- Devices list: Tailscale machines (mobbin.com/screens/df8e39bc-…), Revolut and Wise device lists (a33d51b9-…, 95f7ef8e-…), anatomy only.
- Two versions: Salesforce Compare leads (5dc154a3-7f3d-4869-8a5d-1398d85fb0ca), Front Review your merge (0ecf2195-42d2-4db8-a7c4-46a176759c17), Air duplicate choice (ac2d76ce-872c-4bfc-959f-38c97719f1c1), anatomy only.
- Written fresh; no code was copied.
