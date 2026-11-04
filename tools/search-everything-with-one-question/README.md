# tools/search-everything-with-one-question/

One question over everything a person keeps: every list and record, and their files by name, merged into one ranked
list, best first, each hit with the address that opens it.

This is old trillion's `search` tool (Trillion-X/trillion `src/file-tools.mjs:125`, which asked GET `/namespace/search`,
`src/namespace.mjs:2127`, finished by `src/search.mjs:1750` `finish`). trillion-rust ported it into the engine as
`search_everything_at` (`src/native_boot/mcp_local.rs`) and `record_value::search::merged`. Under the engine's feature
boundary (trillion-rust `engine-feature-boundary.json`, Avery 2026-10-29: every feature is a Workshop tool), both moved
here one to one and were deleted from the engine in the same change. The engine keeps only the two storage reads this
tool calls:

- `records:search { question, type?, limit? }` at `@own-records`: the records holding every asked word, found through
  the record store's word index (fed by every write, `src/storage/record_store/segments.rs`), each kind ranked as its
  own lane by reciprocal rank (`1 / (k + rank)`, k = 60).
- `search { question, limit? }` at `@namespace`: the files whose names hold every asked word, scored `0.8 / (k + rank)`.

## What it does (`do-work/search-everything.mjs` `searchEverything`)

1. With no `type`, ask the files' name search with the question and limit. A refusal (for example a caller with no
   files right, `no_files`) is named in `unavailable` as `{ place: "name", source: "files", reason }`, never guessed.
2. Ask `records:search` with the whole input. Its refusal is the answer's refusal (thrown).
3. When the files took part (answered or refused), merge (`read-data/merged.mjs`): every result by score, best first,
   cut to `limit` (60 when left out), every `unavailable` and `pending` kept. Otherwise answer the records' answer as it is.

## Rows

| Row | Runs | Reaches |
|-----|------|---------|
| `tool:search-everything-with-one-question` | on the person's computer, through their own Trillion MCP client (`records-door/do-work/run-with-stdio-mcp.mjs`) | every kind and every file name |
| `tool:search-one-of-my-lists` | a small container, with a records right on the one kind its `type` names | that kind only |

A Workshop run's records right names one kind (trillion-rust `account_rights/run_capability.rs`; a right's `kind`
filled from an absent input field is refused, never widened), so a run cannot search every kind at once. The person's
own client can.

## Files

| File | Purpose |
|------|---------|
| `do-work/search-everything.mjs` | `searchEverything(input, { door })`: the search, as above. |
| `read-data/merged.mjs` | `merged(question, terms, answers, refused, limit)`: several owners' answers as one. |
| `read-data/settings.json` | The operation names, the default limit and the files lane's place and source, as the engine ships them. |
| `test/search-everything.test.mjs` | The merge, the files lane's refusal, `type`, and 10,000 rows across 3 lists through a door that searches. |
