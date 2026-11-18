# tools/find-checkbox-tasks-and-nested-hashtags-written/

Find checkbox tasks and nested hashtags written inside note text. This folder is the parser only: `parseNoteText(text)` reads the text it is given and hands back its tasks and tags as values; `identityOf` and `noteTextIdentity` give the BLAKE3 identity of a text. It keeps nothing and reaches no store.

The rows the parse feeds (the note sources, the tasks and the tags, with their indexes and their reads) are kept in the person's own store by `workflow:keep-note-tasks-and-tags` (tools/workflows/recipes/keep-note-tasks-and-tags.json, with its kit in tools/workflows/kits/). Proof: run on SQLite and PostgreSQL with the same example answers (lane w33-5, folder find-checkbox-tasks-and-nested-hashtags-written, proof.mjs).

## Where each removed function lives now (src/note-text-index.mjs before this change)

| Removed | What it did | Now |
|---|---|---|
| `noteTextIndex(sql)` tables and indexes | three derived tables in SQLite | `workflow:keep-note-tasks-and-tags`, render step |
| `index`, `remove`, `rebuild` | keep a note's rows, skip unchanged text, drop, rebuild | recipe operations `index`, `remove`, `rebuild` |
| `tasks`, `tags`, `itemsForTag` | the reads with space, done, kind, after, limit | recipe operations `tasks`, `tags`, `items_for_tag` |
| `syncResults` | index the person's notes kept as file results, drop gone ones | the recipe takes the notes from the person's own note rows, whatever table keeps them |
| `noteTextStore` | bring the index up to date before each read | the recipe's `keep` step reads after the store's own rows are current |
| `handleNotesApi` | GET routes over the index | the caller's route, reading through the recipe (in the caller's repository) |
| `noteTextActions` | list-tasks, list-tags, items-for-tag | the recipe operations of the same names |
| `isNotesPath` | route test for /namespace/notes | the caller's route |

One rule changed: a tag's display was the largest explicit spelling in SQLite's collation. It is now the spelling first written explicitly, or when none is explicit, the spelling first kept. The example answers are the same.

The old source is `src/note-text-index.mjs` at the old commit b6ae0ebf815f2f5271eed34e6e023c7e1767ec04 (see `moved-from.json`). `moved-from.json` still records the bytes as first moved; the file here is the parser only.

The limits and patterns are DATA in `tools/shared-code/src/note-text-index.json`.
