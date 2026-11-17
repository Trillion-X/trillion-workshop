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
small container (through `tools/workflows`'s `do-work/run-a-function.mjs`). It reads
nothing and keeps nothing; everything it works on is its input:

- `settings`: the starter map (the areas, the person's map list definition, the reading, the words), required.
- `pursuits`: `[{ title, areas }]`, required; the caller's AI reads them from the person's `pursuit` rows.
- `map_rows`: the rows of the person's own map list `your-map` (rows `record:your-map:<area id>`), read by the caller's
  AI from their list. Left out or null, the person has no map: the answer is `offered: true` and nothing is placed;
  the starter map is never used in its place.
- It writes nothing; making the person's map stays with their own account (the module's `lifeMap().ensure`).

## Files

| File | Purpose |
|------|---------|
| `src/life-map.mjs` | `useLifeMapSettings`, `starterAreas`, `lifeMap`, `keptAreas`, `placeOnMap`, `mapForReading`, `missingLines`, `lifeMapSection`, `lifeMapSettings` (the handed-in starter map). |
| `do-work/place-pursuits-on-a-life-map.mjs` | The tool's run: the starter map from its input, the person's own map from their lists, the pursuits placed by the module. |
| `read-data/place-pursuits-on-a-life-map.json` | Every refusal's words. |
| `test/place-pursuits-on-a-life-map.test.mjs` | A made-up starter map: the module, the tool over its input, refusals, and the row run. |
| `tool-rows.json` | The Workshop row. |
| `part.json` | Public files, and the tree that imports them. |
