# Coss controls

Native-checkbox decoration leaves inputs inside existing shared Checkbox or
Switch roots with their original owner. These hidden inputs implement the
licensed control's form and keyboard behavior; wrapping them again would paint
a second control and move nodes still owned by React. Ordinary native choices
continue to receive the shared visible replacement.

The shared dialog backdrop and viewport use `LAYER_ORDER.dialog`, above floating
navigation and below menus. This keeps review dialogs fully reachable when a
sidebar is portaled over the workspace.

`mountRecordTable` composes the licensed Table, Checkbox and Button
sources for data-driven columns, row selection and actions. The caller supplies
plain text values and stable row identities; no product-specific table markup is
required. Shared appearance stays in screen-look/coss-workspace.css. Expansion's
main Library uses it for transcripts, keyboard selection, previews and copying.

`mountRecordEditor` composes the existing Card, Input, Textarea and Button sources
for bounded editable record lists. Field names, labels, multiline choice and list
bounds are caller DATA. Reads preserve multiline text and delimiter characters;
stable row identities prevent other rows losing edits when one is removed.
Appearance remains in screen-look/creative-workspace.css.

The publication composer’s shared platform → account → format tree, including
removal of saved destinations that are temporarily unavailable, is documented
in [`publication-workspace.md`](./publication-workspace.md).

MIT source from Coss `apps/ui` at the commit in `provenance.json`. The recorded
hashes identify upstream files. Local adaptation replaces demo-registry import
paths with relative imports; component behavior and licensing are unchanged.
The repository's root AGPL license is not the license of these files; the
upstream `LICENSING.md` explicitly selects MIT for `apps/ui`.

`ui/button.tsx` says a button's work in the button itself through the one owner shared with the other Button,
`../button/press-work.tsx` (21st.dev Loading Button, ddoemonn/loading-button): a press whose `onClick` returns a promise
is the work, nothing else to wire. `work` `'pending'` (also what `loading` means) draws the one loading animation beside
`pendingLabel` (else its own words) and takes no presses; `'done'` draws a check and `doneLabel` on the good colour;
`'error'` draws a mark and `errorLabel` ("Try again") in the danger colour; then its own label again. Pass `work` only
for work run elsewhere. Checked over every variant by `test/button-work.test.mjs`.

`ui/toast.tsx` is the one on-screen renderer for the shared notification center
(`../notifications`): Coss's stacked Base UI geometry, each card drawn from a
notification record with a DATA-driven glyph, live progress, actions and a
hover-revealed dismiss. `notifications.tsx` is its imperative front door (the panel, `mountNotificationPanel`, is `notification-panel.tsx`, fetched only when a screen shows it)
(`notify`, `clearNotifications`) and mounts the stack plus the history bell once
per document. The unused anchored-toast variant was removed. A record re-emitted
unchanged (a caller reading its list again on every store change) updates its
card without naming a timeout, because Base UI restarts a card's timer whenever
an update names one; only a changed timeout restarts it.

`dom-controls.tsx` adapts the real dialog and searchable checkbox controls for
imperative applications. Source Button variants and source Input markup also
decorate existing form elements without replacing their event handlers or
values. This is not a wholesale conversion of the consumer to React.

Consumers must resolve one React instance for the bundle. Local imports no
longer require an `@/registry/default` alias. Dependencies: Base UI (the primary
workspace pins `@base-ui/react` to 1.8.0), React, React DOM,
class-variance-authority, clsx, tailwind-merge and lucide-react. Appearance is
compiled from these source classes by Tailwind 4 plus the screen-look owner
`show/coss-workspace.css`. Expansion's `build-shared-controls.mjs` is the current
consumer and records exact source hashes in its generated manifest.

The loading rows (three-card Gallery, `rows`, `preview` and `editor` layouts,
each a named `role="status"` whose screen-look spacing reserves the arriving
content's footprint) moved to `../screen-state/`, together with the empty and
failed states, so a screen's three read states come from one part. Callers own
the loading label and choose the layout from their current surface.

No demo content, simulated thinking, or model behavior is part of these controls.
The app still owns its data, labels, actions, and media player.

Media browsing supports `quiet: true`: visual cards show their thumbnail while
retaining accessible names and tooltips; audio retains its identifying text.
`onInsert` makes the main card activate insertion, with an on-demand accessible
preview button using the existing `onOpen`. Selection and drag callbacks remain
independent. The consumer supplies contextual batch actions. `enhanceButtonGroup`
tracks asynchronous button additions, label and availability changes; optional
`omitDisabled` keeps unavailable actions out of the overflow menu. Appearance
lives in screen-look. Expansion's installed interaction evidence is recorded in
the indexed library-reference-redesign knowledge leaf.

The table adapter uses upstream Table/Header/Body/Row/Head/Cell markup while
retaining the consuming table and its button nodes. It does not claim to add
sorting or virtualization. `mountMediaGrid` composes upstream Card, Button and
Checkbox for media records with controlled selection. Searchable multi-choice
lists also support optional select-all and externally owned search.

Native checkbox adaptation retains the input as the accessible label/focus,
FormData and event owner; Coss renders its visible state. Native property writes,
form resets and disabled changes stay synchronized. Media cards support optional
selection, descriptive secondary text and a failed-image fallback without losing
the open action. The consumer owns URL construction and what the card opens.

`guide-progress.json` (DATA) says how a guide draws how far along the person is: one dot per step up to `dots_at_most`, then one short filled bar (`.guide-progress-track`), so a long list (every tour) never runs off the screen.

`guide.tsx` draws a guide description; a section may carry `checks` (lines with a check mark), `choose` (one pick
among open times, drawn by `time-slot-picker.tsx`, sent with the section's field-sending actions, which wait for a
pick), a `split` (one total cut into labelled parts, drawn by the shared `UsageMeter` as one bar with a legend: `{ total, words, parts: [{ id, label, amount, words, tone }] }`) and a `footnote`; an action's `busy_label` is shown while it runs. A section's `id` is drawn as
`data-guide-section`, so a tour step can point at that section, and a step's `actions` draws one button per action
after its `link` and `action`. Every copy in a guide is the shared `copy-button` part: a code line's icon-only copy, a
card's and a section prompt's Copy, an action's `copy`, and a tab's `copy` (`{ text, copied_label }`), which copies
when the tab is picked and says Copied on the tab itself. A description's `badge` (`{ label, tone }`) is a pill beside
its title (the shared `Status`), such as how many tours are taken. A `catalog` may carry `selection` (actions over picked rows): each list row then draws a pick box (`.guide-row-pick`) with `Pick all N shown` above the list, the table's own checkboxes change the same selection, and the record views' selection bar runs the action, sending each picked row's `pick` under the action's `send.selection` name (Connections: Let my AIs read these). `time-slot-picker.tsx` (`TimeSlotPicker`)
lays out a month with the open days lit (the shared `calendar-grid` in its picker density) and the chosen day's times
beside it (under it on a narrow pane); days and times arrive as DATA already in the viewer's zone.

A field with `kind: 'text'` is a box for several lines (the Coss Textarea), such as a pasted export.

A step (`Steps`) draws a card: its mark is the shared step mark (`done: null` is `checking`, and the body is hidden once `done` is true); `owner` (`you` or `ai`) prints its owner line; `progress` (`{ done, total, label }`) draws a bar with its label; `items` draw chips (the logo, name, optional `status` and `action`), and past 8 a `+N more` toggle shows the rest; `add` is one button under the card. Its chips and the card wrap at 390px (`screen-look/show/guide.css`).
A guide row may also carry a `logo` (a picture address, drawn by `logo.tsx`), `items` (the things under it, such as
the accounts connected to a service or the values of a saved login, each with its own actions shown on hover or focus;
an action answered with a `reveal` shows it under the item that asked, and `reveal.hide_after_seconds` hides it again; the
guide holds each shown value under the action that asked (`useReveals`) in a store outside the drawing
(`guideReveals()`, which a screen makes once and passes to every guide it draws as `reveals`), so the redraw that same
answer asks for (`refresh`) never drops it, even when that redraw draws the row or the whole guide again, and it still
hides at the time it was first shown; an item's `automations`,
`[{ id, label, on? }]`, lists what runs by itself behind it, each with the shared automation hover card and
click-to-edit from `../automation-preview`) and `facts`. A row whose own
action starts it has no second open button; its disclosure arrow opens the steps. A status is a chip with a dot in its
tone. A link to another site is a real `<a target="_blank" rel="noopener noreferrer">` with an arrow the size of its
words. A section with a `catalog` ({ label, fields, empty? }) shows its rows through the shared record views
(`record-views/record-views.tsx`): search, Filter, Sort and a Table view over each row's `facts`, with the list view
drawing the rows themselves through a portal so an open row keeps its typed boxes while the person searches. The host
lends the formula engine's filter through `mountGuide(..., { recordFilter })`.

A section may also carry `stats` (number tiles, `stat-tiles.tsx` `StatTiles`: label, big value in the display face,
an optional icon and 0..1 bar, a line under it; two across on a narrow pane), a `thread` (`thread.tsx` `Thread`: a
box to start a discussion, posts with an avatar, author, what it was sent through (`via`: an AI app's mark and name, after
the author), time, words, the words of the post a reply is about, a vote
pill, reactions (`../reactions/ReactionRow`) and a Reply box, replies nested on a rail that folds; resting on an author
opens `person-hover.tsx` `PersonHover`, nested cards from the face to their posts here to one post with its reactions
and a reply box, so a reply is sent in place; a post's `mentions` are drawn where their `@label` is written as the shared live `RecordChip`
(`../record-chip`); every press goes to the guide's `onAction` with the typed words under `text`) and `ranks`
(`rank-list.tsx` `RankList`: numbered people with an avatar, a line, a badge and a value at the right, the first three
places tinted and the reader's own row lit). The three are adapted from the 21st.dev community components the owner
gathered (Reddit nested thread reply, Activity list, Stats Card), with invented avatars, dead buttons, down votes and
local-only state removed.

A section may also carry a `profile`, a `banner`, an `explain`, a `table` and `courses`, drawn in that order after its
heading and body, and a description may carry `aside` sections and `hide_header`:

| File | Purpose |
|------|---------|
| `notification-panel.tsx` | `mountNotificationPanel(element, {compact?, recordFilter?})`: the notification center's history (or its compact live feed) as a screen body, its own file so a page carrying only toasts (`notifications.tsx`) never carries the panel and its record views. |
| `profile-card.tsx` | `ProfileCard`: a person at a glance (initials avatar, name and tag badge, a line, a meter with its label in the accent and its two end words, labelled fact rows with icons, one highlight tile, a quiet full-width foot action) |
| `person-hover.tsx` | `PersonHover`: resting on a face or name opens their card (face with the look's control corner, name, an underlined "3 posts here"); resting on that line lists the things, and on one opens it, drawn by the caller with reactions and a reply box; every card also opens by press and closes with Escape |
| `banner.tsx` | `Banner`: one line across a section's top (icon tile, small line over a larger one, value at the right, and whatever the host puts at its end) |
| `explain-card.tsx` | `Explain`, `ExplainToggle`, `ExplainPanel`, `useExplain`: "learn more" that opens in place (never a modal): title, line, close button, numbered tiles, a ladder with the current rung in the accent; Escape closes and returns focus |
| `rank-table.tsx` | `RankTable`, `ordinalOf`: people by place on the Coss Table ("1st", avatar, name and tag, right-aligned cells, accent columns, the reader's row lit, a quiet gap line after `gap.after_place`) |
| `course-cards.tsx` | `CourseCards`: a wrapping grid of cards with parts to finish (tinted band with icon or initials, title, two-line about, bar with its words, status badge; the whole card is its action) |
| `offer-card.tsx` | `OfferCard`: one offer at a glance (small title, price large in the display face with how often it is paid, a feature list whose opening words are bold behind round check tiles); a guide section's `offer` |
| `press-action.tsx` | `PressAction`: a whole block as one guide action on the Coss Button (external links open a new tab, `confirm` asks in place) |

| Type / function | Shape | Role |
|-----------------|-------|------|
| `GuideProfile` | `{ name, tag?, detail?, meter?: { label, progress 0..1, start?, end? }, facts?: { label, value, icon? }[], highlight?: { title, value?, detail?, icon? }, action? }` | `ProfileCard` DATA |
| `GuideBanner` | `{ icon?, title, value?, detail? }` | `Banner` DATA; the section's `explain` button sits at its end |
| `GuideExplain` | `{ label, title, lead?, steps?: { title, body? }[], ladder?: { label, note?, rungs: { name, detail?, current? }[] } }` | `Explain` DATA |
| `GuideTable` | `{ columns: { id, label, align?, accent? }[], name_label?, rows: { id, place?, name, tag?, detail?, highlight?, cells, action? }[], gap?: { after_place, text }, empty? }` | `RankTable` DATA |
| `GuideCourse` | `{ id, title, about?, icon?, done?, of?, progress_label?, status?: { label, tone? }, action? }` | one `CourseCards` card |
| `GuideDescription.aside` / `.hide_header` | `GuideSection[]` / `boolean` | a sticky side column on a wide guide (the guide is its own `guide` container, two columns from 46rem), stacked after the main sections when narrow; leave the title out when the host names the screen |
| `ThreadDescription.style` | `'discussion' \| 'cards'` | `'cards'` draws each top-level post as its own card (avatar and author, words, a foot row with the vote pill, replies count, Reply and the time at the right), replies folded inside it |
| `mountSectionedSpace(node, frame, { onNavigate })` | `→ { content: HTMLElement, update(next), unmount() }` | draws the space into `node`; choosing a place calls `onNavigate(id)` and the caller decides what `content` shows, then calls `update` |

The accent these parts use is `--guide-accent` on `.guide` (a warm terracotta by default; a look may set
`--color-guide-accent`). Anatomy comes from the Promethee screens the owner captured (profile card, leaderboard, "How
ranking works"), Skool's classroom cards, and 21st.dev's Leaderboard Table (30672), Profile-Card (2593), Progress Card
(7793) and Project Item Card (28524); only anatomy was adapted, no source was copied, so `provenance.json` gains no rows.

An action may carry an `icon` (a NamedIcon name) and `icon_only` (the icon alone, its label as name and hover title),
or `switch: { on }` to draw as the one shared switch (`ui/switch.tsx` re-exports `../switch`, the 21st.dev 21948 look) with a short
label; flipping it runs the action, and its `confirm` is asked in place before it turns on. The tone `plain-danger` is a
ghost button in the danger colour. A catalog's rows are cards with room between them, and each service's line is cut
to one line; the accounts under a row keep their actions in their own column, so the actions never cover the words.

`logo.tsx` (`Logo`, `initialsOf`) draws a company's or thing's mark: the picture in a rounded tile, or the first letters
of its name when there is none or it does not load (the Coss Avatar's image and fallback).

`logo-fan.tsx` (`LogoFan`, `LogoFanDescription { center, around, caption? }`) draws one mark raised in the middle with the
others fanned out and tilted by their distance from it (after Higgsfield's "MCP for any AI" hero,
mobbin.com/screens/93b4c668-a280-4a11-961a-1f5d13601b56); a guide section's `fan` draws it under the section's words.
Guide `tabs` are equal tiles in a wrapping grid (after Klaviyo's provider picker,
mobbin.com/screens/0c6903c3-5ec3-40bd-befb-4b8d5f68dfe4), each with its `picture` (a logo address) or `icon` before its
label; look in `screen-look/show/guide.css`.

`workspace-controls.tsx` mounts upstream Menu, Select, Card, Badge and Avatar components
for existing applications. Native selects retain FormData ownership; property
changes, option mutations and form resets update the visible source control.
Disconnected roots release their observers and listeners. Project navigation,
cards and conversations receive records and callbacks, never channel-specific
branches. Conversation activity reflects the caller's actual job state.

The publishing workspace uses the service-connections `ProviderMark` registry for
both platform headings and account rows. The same current registry rows flow to
both levels, so updated brand marks repaint without provider-specific UI branches;
the shared renderer keeps its safe monogram fallback for unknown providers.

Media-card metadata uses the exact pinned MIT Coss Badge source. One leading
badge remains inside the card and a Coss Menu exposes every remaining project,
tag or review destination. Long names keep their full title while the visible
label truncates within the card. `mountActionPrompt` composes Coss Card, Button
and Menu with the shared movable-toolbar controller; consuming apps supply only
the current summary, actions and callbacks and may not author another prompt
surface or its appearance.

Standalone metadata groups provide their own `.coss-ui` scope so the Coss Badge
appearance stays active when a caller mounts topic or label buttons outside a
media card.

Chat layout, message stream and composer now delegate to the complete MVPBlocks
WorkingChatbot adaptation in `../mvpblocks/WorkingChatbot.tsx`. The former custom
message renderer and BeautifulUI composer implementation were deleted. This does
not claim provider token streaming is implemented.

Notifications now consume the unchanged MIT Coss `ui/toast.tsx` at the same pinned commit, with Base UI lifecycle and announcements. `notifications.tsx` bridges imperative callers, adds a keyboard-accessible Dismiss action, and clears transient notices before a new dialog opens. Shared `screen-look/show/notifications.css` places them at the top and respects reduced motion.
`mountMediaGrid` accepts generic per-item `actions` (`id`, `label`, optional variant/disabled) and `onAction(itemId, actionId)`, plus `openDisabled` for unavailable content. Optional `groups` carry labels and items without imposing domain-specific grouping. Expansion uses these source Card/Button/Checkbox components for Library cards and draft review actions instead of bespoke grids. Product states and action routing remain in the consumer.

Grid and table consumers can supply `selectionMode` plus `onSelectionGesture` for ordinary, Command/Control-toggle, and Shift-range selection without changing open behavior elsewhere. Media grids also accept `onMarqueeSelect` for pointer rectangle selection over the shared card identities.

`mountProjectTree` renders arbitrary-depth folder data with selectable parent and
leaf rows, recursive disclosure, ancestor-preserving search, keyboard navigation,
multi-selection, and root or nested creation. Tree search and row construction use
iterative walks, so folder depth does not depend on the JavaScript call stack. The
consumer owns names, graph validation, membership writes, and product routing.
Given `rowPreview` (`{glance?, actions?, description?}` as raw app DATA), every
manageable row opens the shared `surface-preview` hover card: that row's glance
and actions with `{id}` and `{name}` filled per row, plus Rename (or Edit details)
when the tree can rename. Pickers pass no `rowPreview` and show no card.

With `selectionMode: 'none'` the same tree is a navigator (a sidebar's folders): no checkboxes, a row with
children opens and closes, and choosing any other row calls `onOpen(id)`. A row marked `expandable` shows its
disclosure before its children are known; opening it asks `loadChildren(id)` once, and the handle's
`refresh()` reads the top level (`reload`) and every opened row again. `namedIcon` draws a Lucide icon for a
row, and `searchLabel` and `emptyLabel` carry the caller's words.
A navigator's rows take the sidebar row's geometry (screen-look `coss-workspace.css`): the disclosure in the
sidebar's 24px grip slot as the section headings' 12px chevron, an 18px icon at the row icon column, a 14px name, 34px rows, and
each level indented 20px so a child's guide sits under its parent's chevron.
Every mode draws the same motion (after 21st.dev #25640 "Animated File Tree", by arunachalam, and #20042, by
unlumen) and the same guides as a sidebar list (`ui/show/nesting-guide`, the owner 2026-09-30): beside an open row's
rows runs one soft pill, rounded and inset at both ends, from its first row to the last row of its open subtree,
computed from the rows themselves (`buildProjectTreeRows` gives each row `guides`, one `{start, end}` per level,
nothing is measured); the
disclosure chevron turns a quarter as a row opens; a row's children grow in and shrink out with their height
(framer-motion, instant under reduced motion); the hover highlight glides to the row under the pointer or keyboard
focus. A row's `tone` (a tone of the shared look: blue, green, purple, yellow, red) colours its icon, from the
caller's DATA (the Your files tree reads `tree_tone` in `src/workspace/file-previews.json`).
Shared density and responsive containment live in
`screen-look/show/coss-workspace.css`.

`mountNavigation` renders optional detail text with the licensed Button/Avatar source. `mountActionCards` composes unchanged Coss Card and Button primitives from generic item/action data. Organization review consumes these for bounded recording navigation and reversible rule controls; rules and backend semantics remain in Expansion.
When an action callback returns a promise, its card disables sibling actions for that item, shows the existing Button spinner and an announced action label, and re-enables the controls when the promise settles. Product copy may supply `loadingLabel`; action routing and error recovery stay with the caller.
Completed inline guide forms show an Edit action. The saved answer remains in the caller's summary; Edit opens the existing fields with their saved values, Cancel closes without sending, and a refused save keeps the edited values. Unfinished forms still open immediately. The shared Button keeps its own saving and failure behavior. Verified with `test/form-scroll-and-completed-step.test.mjs`.
