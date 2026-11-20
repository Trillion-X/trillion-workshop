# tools/place-pursuits-on-a-life-map/

A person's pursuits placed on their own map of a full life: which areas each pursuit touches, and the parts of life none of
them touches. The map is the person's own: its rows are read by the caller's own SQL, in whatever form their store keeps
them, and handed in. Someone else's map (a coach's wheel, a faith's parts of life) runs the same way.

## Files

| File | Purpose |
|------|---------|
| `src/life-map.mjs` | `mapAreaOfRow`, `mapAreas` (rows to areas, in tree order), `keptAreas` (keeps only the ids of the map), `placeOnMap` (pursuits on their areas, and the leaf areas none names), `mapForReading` (what a reading is handed about the map). Pure: runs no SQL, writes nothing. |
| `test/life-map.test.mjs` | `node --test` suite over made-up map rows. |

## Where it is used

`tools/keep-a-continuous-awareness-reading/src/reader.mjs` imports `keptAreas`, `mapForReading` and `placeOnMap`, and its
`do-work/read-awareness.mjs` builds the map from the rows the caller hands in with `mapAreas`.

## Changed from the old code (on purpose)

- Tree order sorts siblings by label. The old `treeOrder` sorted them by the starter map's order first; the starter map is
  not read here any more (its rows are the person's own), so that order no longer exists in this module.
- The old `lifeMap()` (making the person's list from the starter rows, and the list reads) and `lifeMapSection` (Progress's
  table) are not here. Making the map and showing it are the map owner's and the screen owner's work.

## Running

From the Workshop root:

    node --test tools/place-pursuits-on-a-life-map/test/*.test.mjs
