# tools/place-pursuits-on-a-life-map/

A person's pursuits placed on their own map of a full life: what each pursuit touches, and the parts of life none of
them touches. The map is the person's own list, made from a starter map only when they choose it; someone else's map
(a coach's wheel, a faith's parts of life) runs the same way.

Moved from Trillion-X/trillion (commit 42aff4e9dc) by `tools/move-code-between-trees`: `src/life-map.mjs`
(`moved-from.json` names its source and both identities). Its content, `src/life-map.json` (the starter map), was not
moved: it becomes rows of the account owner's own lists through a separate import, and the module takes it from its
caller. This folder holds the one copy: Trillion's own in-account run imports `src/life-map.mjs` from this package and
hands it the starter map it keeps (`useLifeMapSettings(settings)`, or each call's `settings`).

## How it runs

`tool:place-pursuits-on-a-life-map` runs `do-work/place-pursuits-on-a-life-map.mjs` `placePursuitsOnALifeMap` in a
small container through the person's records door (`tools/records-door`):

- The starter map's areas are the rows of the list `life-map-areas` (rows `record:life-map-area:<area id>`), and the
  rest of it (the person's map list definition, the reading, the words) is the row `record:content-setting:life-map`.
  Those ids are data (`read-data/place-pursuits-on-a-life-map.json`), named for the import that keeps the content as
  rows, which lives outside this repository; if it keeps them elsewhere they are corrected there and in the row's
  rights. `settings` in the input is used instead.
- The person's own map is their list `your-map` (the starter map's own list id; rows `record:your-map:<area id>`),
  read once through `tools/records-door/read-data/lists-door.mjs` and served to the module as it reads lists. With no
  such list the answer is `offered: true` and nothing is placed: the starter map is never read in its place.
- Pursuits are `pursuits` in the input, or the person's `pursuit` records (title and areas).
- It writes nothing; making the person's map stays with their own account (the module's `lifeMap().ensure`).

## Files

| File | Purpose |
|------|---------|
| `src/life-map.mjs` | `useLifeMapSettings`, `starterAreas`, `lifeMap`, `keptAreas`, `placeOnMap`, `mapForReading`, `missingLines`, `lifeMapSection`, `lifeMapSettings` (the handed-in starter map). |
| `do-work/place-pursuits-on-a-life-map.mjs` | The tool's run: the starter map and the person's own map from their lists, the pursuits placed by the module. |
| `read-data/place-pursuits-on-a-life-map.json` | Where the maps are kept (lists, row types, row id), where pursuits are read, and every refusal's words. |
| `test/place-pursuits-on-a-life-map.test.mjs` | A made-up starter map: the module, the tool over an in-memory door, refusals, and the row run with its rights. |
| `tool-rows.json` | The Workshop row. |
| `ports/read-the-map-from-lists.json` | The port contract of the run: no older owner reads the maps from lists (its module is the moved one). |
| `part.json` | Public files, and the tree that imports them. |
