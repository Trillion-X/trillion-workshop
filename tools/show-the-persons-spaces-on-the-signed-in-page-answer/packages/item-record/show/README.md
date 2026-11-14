# item-record/show/

Show code for this package renders package-declared inputs and browser-local visual state only.

It does not own durable state, execute work, call providers, import slot internals, or parse source-system data.

## Files

| File | Purpose |
|---|---|
| `mount-item-record.tsx` | Entry source: mounts the feed through `mountReactMaterial` from `@/packages/ui`, passing host-supplied props through |
| `ItemFeed.tsx` | Loads the admitted subject-scoped item list, renders the DATA-selected composer above newest-first post cards with replies, and shows finite loading, retry, and DATA-authored empty states using shared UI components |

The list refetches through `item-record.read-feed-items` when the surface mounts and after the composer emits `item-record:changed`. Reloads read durable item-owner rows; the browser does not depend on a page-local cached feed.
