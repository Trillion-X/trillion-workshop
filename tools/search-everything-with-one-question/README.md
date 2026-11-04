# tools/search-everything-with-one-question/

One question over everything a person keeps: every list and record, and their files by name, merged into one ranked
list, best first, each hit with the address that opens it.

This is old trillion's `search` tool (Trillion-X/trillion `src/file-tools.mjs:125`, which asked GET `/namespace/search`,
`src/namespace.mjs:2127`, finished by `src/search.mjs:1750` `finish`). trillion-rust ported it into the engine as
`search_everything_at` (`src/native_boot/mcp_local.rs`) and `record_value::search::merged`. Under the engine's feature
boundary (trillion-rust `engine-feature-boundary.json`, Brian 2026-10-29: every feature is a Workshop tool), both moved
here one to one and were deleted from the engine in the same change. The engine keeps only the two storage reads this
tool calls:

- `records:search { question, type?, limit? }` at `@own-records`: the records holding every asked word, found through
  the record store's word index (fed by every write, `src/storage/record_store/segments.rs`), each kind ranked as its
  own lane by reciprocal rank (`1 / (k + rank)`, k = 60).
- `search { question, limit? }` at `@namespace`: the files whose names hold every asked word, scored `0.8 / (k + rank)`.

## What it does (`do-work/search-everything.mjs` `searchEverything`)

It is old `finish` (`src/search.mjs` lines 1750-1798 and 1893-1917 at b6ae0ebf), moved byte for byte and then adapted
(`ports/search-everything.json` names every change):

1. The lanes are the two storage reads (`read-data/settings.json` `lanes`): `records:search`, each record kind it
   answers its own lane (rank 1), and the files' name search (rank 0.8), asked only when no `type` narrows the question.
   Both are asked with the same question at once.
2. A lane that cannot answer (for example a caller with no files right, `no_files`) is named in `unavailable` as
   `{ lane, place, source, reason }`, never guessed. A refusal of the records' search is the answer's refusal (thrown).
3. Each lane ranks its own hits; things are merged by reciprocal rank fusion (`rank / (k + rank in the lane)`, k = 60,
   summed over the lanes a thing was found in), best first, cut to `limit` (60 when left out). Each result is its
   owner's hit, with its `address`, plus `found_in`, `places`, `moments`, `said` and the fused `score`.

## Rows

| Row | Runs | Reaches |
|-----|------|---------|
| `tool:search-everything-with-one-question` | on the person's computer, through their own Trillion MCP client (`records-door/do-work/run-with-stdio-mcp.mjs`) | every kind and every file name |
| `tool:search-everything-in-a-small-container` | a small container, with two read-only rights: `{kind: "*", operations: ["records:search"]}` and `{files: "/", operations: ["search"]}` | every kind and every file name, writing nothing |
| `tool:search-one-of-my-lists` | a small container, with a records right on the one kind its `type` names | that kind only |

A Workshop run's records right names a kind, or `*` for the read-only search over every kind (trillion-rust
`src/account_rights/run_capability.rs` and `src/record_value/records-door.json` `run_operations` `every_kind`). The
`*` right covers only a `records:search` that names no kind: the engine refuses a row that names `*` with any other
operation, an id or a prefix, a search that names `type: "*"`, and every write, read or list the run tries with it. A
right filled from an absent input field is still refused, never widened.

## Files

| File | Purpose |
|------|---------|
| `do-work/search-everything.mjs` | `searchEverything(input, { door })`: the search, as above. |
| `ports/search-everything.json` | The port contract: the old lines, the byte-copy commit, what was kept and what was adapted. |
| `read-data/settings.json` | Old `src/search.json`'s numbers and place labels, and the two lanes with their operations, places, sources and ranks. |
| `test/search-everything.test.mjs` | The fusion, the files lane's refusal, `type`, the records' refusal, the one-list row, 10,000 rows across 3 lists, the container row over three kinds and the files (and refused without its right), and the `*` right never writing. |
