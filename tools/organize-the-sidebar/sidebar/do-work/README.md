# sidebar/do-work — sidebar-owned dispatchers

Requests the sidebar sends by address. Zero membership/layout logic — ops and records are built here, executed elsewhere.

## Files

| File | Purpose |
|------|---------|
| `ask-discovered-addresses.ts` | Sidebar-shaped request to discovered addresses. |
| `update-sidebar-placement.ts` | Placement record write via `action:update-sidebar-placement`. |
| `edit-surface-collections.ts` | Surface-list verbs (create/rename/delete/add/remove/reorder) as self-describing op batches dispatched to `group.apply-mutation`; listing via `group.load-graph`. A new list keeps when it was made (`made_at`); `setSurfaceCollectionRules(collection, { holds?, order_by?, shown_when? })` keeps or takes off a list's rules (null takes one off). |
| `surface-collection-ops.ts` | Pure op builders for every list change (`createListOps`, `patchListOps`, `deleteListOps`, `addRowOps`, `removeRowOps`, `reorderRowOps`, `saveAsShownFirst`, `rowMemberId`, `patchRowOps`). `createListOps` takes the list's first meta (when it was made, its rules); `patchRowOps` keeps a row's `shown_when` in its place in a list. The page (`edit-surface-collections.ts`) and the Worker (`src/sidebar.mjs`, the AI's `change_sidebar`) change lists with the same ops. `addRowOps` marks the row `placed_by_person`, so a row the person (or their AI) put in a list stays there when the app later lists that screen elsewhere. |
| `collection-view-preference.ts` | ONE `sidebar-collection-view` label_hash record for the show-all/per-list toggle + collapsed flags (value is DATA, no enum). |

**Depends on:** `@bitfield/runtime-kit` (target sender), `read-data/read-surface-collections` types.
**Depended on by:** `show/AppSidebar.tsx`, `show/CollectionManagerRow.tsx`, `show/ListShowsWhen.tsx` (a list's When it shows), `src/sidebar.mjs` (the AIs' `change_sidebar`, the same ops).
