# one-at-a-time-queue

A long list of tasks shown one at a time. Each card uses the shared ListingCard glance shape for its title, short description, icon-led facts and record chips, then presents the task's own action and moves.

## Files

| File | Purpose |
|---|---|
| OneAtATimeQueue.tsx | Position, focused ListingCard summary, finish action, Back/Open/Later moves, empty and put-off states. Long forms keep their submit action visible while fields scroll. |
| index.ts | The public entry declared in ui/part.json. |

## Key types

| Type | Shape | Role |
|---|---|---|
| OneAtATimeQueueProps | { title, things, total, words, empty, rest, leave?, alone? } | Caller-provided content and actions. alone shows one thing by itself, with its ways out inside the card. |
| QueueThing | { key, title, icon?, byline?, when?, detail?, body?, meta?, clip?, clipLabel?, audioNote?, finish, open?, explain?, chips?, factChips?, links? } | One task. links are quiet links under the title (the goal the task serves), never boxed chips. byline and when fill the ListingCard's source and date slots; body replaces the one-line detail; clipLabel names a playable segment; audioNote supplies caller-owned status copy when no playable recording exists; explain rows optionally name a purpose/completion/context role. Purpose precedes the owning artifact/action surface, completion follows it, and other context uses the shared ListingCard facts. Empty and repeated facts are omitted. |
| QueueFinish | press, form, or checked words | How the task is finished: a press, an inline form, or a status that the caller updates. |
| QueueAction | { label, run } | A caller-provided action. |
| QueueWords | { position, later, back, working, done, again } | Localized queue controls; position fills {n} and {total}. |
| QueueEmpty | { icon?, title, detail?, action? } | The empty state. |

## Dependencies

Depends on: coss/ui/button, icon, audio-clip-player, listing-card (ListingCard, ListingFact, ListingChip), fact-chips, record-chip, record-views/hover-form (HoverFormBody), safe-error-card; appearance is in screen-look/show/one-at-a-time-queue.css.

Used by: Trillion Waiting on you screen (src/workspace/waiting-screen.tsx, route /waiting).

## Invariants

1. The caller owns all task words, actions and context; the shared component has no product-specific copy.
2. Each task keeps its own finish behavior. A successful finish leaves at once; a refusal stays beside the action.
3. The summary uses the shared ListingCard structure. Purpose, completion and supporting context stay visible in their own places; matching fact and chip values appear once, as the chip; values and source/date text wrap in full. There is no disclosure press concealing the task explanation.
7. The finish press is the shared primary button at its own width, first in the card's footer row, with the caller's ways out beside it on that row; never a full-width slab. A form or checked finish stays in the card body.
4. Reduced-motion preferences turn off the card slide.
5. A thing body, when given, is drawn instead of its one-line detail; an empty checked finish draws nothing.
6. Moves that cannot be made are not drawn. In alone mode, the task and its ways out remain one card.

## References

- Deepstash onboarding deck on Mobbin (https://mobbin.com/screens/6ba924f6-614d-4926-9896-01931d5c7714): one focused card with the next cards peeking behind it.
- Glassdoor apply review on Mobbin (https://mobbin.com/screens/bb280338-6d8f-418a-8702-7a31f1cd8843): a focused column and back navigation.
- Uxcel review answers on Mobbin (https://mobbin.com/screens/4ba413cf-295e-40d4-8b31-33d7d48c548e): position shown beside navigation.
- 21st.dev Tool Approval, component 26580 (https://21st.dev/@saurabh10102/components/tool-approval): one filled press sized to its words at the start of a hairline-divided footer and quiet choices beside it. Its disclosure anatomy was removed because purpose and completion must stay visible. Anatomy only; no source code was copied.
- October13 registry search `task summary card context approval` and retrieved Approval Card23595 (https://21st.dev/@theshanelevine/components/approval-card): direct question/content/action hierarchy, reference only; no source copied. Mobbin tools were unavailable; existing linked reference anatomy retained. Rendering uses the existing MIT Coss controls and shared ListingCard.
- 21st.dev Approval Card, component 36498 (https://21st.dev/@syeddhasnainn/components/approval-card), MIT: informed the brief-description-action hierarchy. No source code was copied.
Long forms scroll `HoverFormBody`'s answer content separately from its submit action, so answer rows never travel behind the button. The submit keeps the shared primary face and occupies its own space. Reference: 21st Dialog Scrollable Content 30837, anatomy only; existing MIT Coss controls reused. `test/form-scroll-and-completed-step.test.mjs` verifies first/middle/last keyboard access across twenty long fields at desktop and phone widths, including reduced motion.
