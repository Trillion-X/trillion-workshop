# tools/documents-as-list-rows/

Shows a folder of markdown documents as the rows of a list. Each document is one row and its frontmatter holds the row's fields. The documents are the rows: nothing is copied into list records, so the files stay the one truth. A field changed in the list is written back into that document's frontmatter, but only if the document is still the one that was read. The tool can also split a long document of many items (rules, lessons, questions) into one document per item, so that each item can be a row. Like Obsidian Bases over a vault.

This is the `documents` row source of the lists, ported from the earlier Trillion app (`src/document-properties.mjs` there). The port keeps its frontmatter reading and writing, links, tags, the property-types sidecar and the conditional write. What changed:
- The rows come from any `files`. `read-data/folder-files.mjs` supplies them for a folder on the person's computer.
- A read is one page of the folder in name order, so a folder of any size can be read.
- The refusal words and the field kinds' value shapes are this tool's own DATA (`read-data/document-properties.json`).

## Running it

The local engine runs the rows on the person's computer (`computer` kind) after the person grants the tool a folder:
- `tool:read-documents-as-list-rows` needs `read-a-folder`.
- `tool:change-a-document-row` needs `change-a-folder`.

Each row is one call of a function in `read-data/rows.mjs`. The granted folder is its `root`, and every other path is under it. By hand:

```
node do-work/documents.mjs rows  --root DIR [--folder SUB] [--match GLOB] [--after NAME] [--limit N] [--backlinks]
node do-work/documents.mjs set   --root DIR --path /NAME --if-identity 1f:... [--set KEY=JSON ...] [--remove KEY ...]
node do-work/documents.mjs split --root DIR --mapping FILE (--check | --out SUB --leftover SUB)
```

Each command prints one JSON answer. Exit codes:
- 0: done
- 1: refused, because the document changed since it was read (read it again)
- 2: unreadable input or a bad mapping, with the reason on standard error

## Rows

`readDocumentRows({ root, folder?, match?, after?, limit?, backlinks?, most_bytes? })` answers `{ rows, next }`. `readNamespaceDocumentRows({ folder?, ... }, { door })` answers the same page from a folder of the person's Namespace files (`tool:read-namespace-documents-as-list-rows`, a container row whose records right is the files folder): `read-data/namespace-files.mjs` reads each file by its name through the run's records door (`door.files`: list_files, then read_file a page at a time, joined as bytes). It writes nothing, because the files door has no write that checks a file is still the one read. A row is `{ id, title, identity, values }`:
- `id` is the document's name under the folder, as `/notes/plan.md`.
- `identity` is `1f:` followed by the BLAKE3 of its bytes (`tools/content-identity`).
- `values` holds the document's own properties as `note.<key>`, and its file facts as `file.<key>`: name, basename, ext, path, folder, size, ctime, mtime, identity, links, embeds, tags and aliases.

How the folder is read:
- Every `.md`, `.markdown` and `.txt` document under the folder is a row. Folders whose names start with `.` are skipped, and so is a link that points outside the granted folder.
- Rows come in name order, `limit` per page (200 by default, at most 2,000). `next` is the last name shown while more remain; pass it as `after` for the next page.
- A listing reads names only, so a folder of thousands of documents costs one directory read plus the documents on the page.
- `match` keeps the documents whose path under the folder fits a glob, as `*/SKILL.md`.
- `file.backlinks` needs every document's links, so it is worked out only when `backlinks` is true.
- `exclude` is an array of globs relative to the source folder. It keeps a broader knowledge source from repeating documents another list already owns.
- `paths` is an exact positive catalogue of file names under the granted root, read without walking unrelated folders. Every name still goes through the files owner's root and symlink checks. `text_extensions` explicitly declares UTF-8 source extensions such as `py` or `mjs` for that catalogue; ordinary folder scans still select only the document extensions. Source bytes are read as text and never executed.
- An empty string in `text_extensions` explicitly admits extensionless UTF-8 files such as a named `LICENSE` or prompt. It only affects the positive `paths`/`paths_file` catalogue; a normal folder scan still excludes extensionless files.
- `paths_file` names a JSON array positive catalogue under that same granted root instead of embedding `paths` in a bounded list record. Its identity is checked, its complete JSON must fit the existing per-document byte read bound, and each selected name still passes the normal root checks.
- `most_bytes` bounds the answer's JSON: the page ends at the last row that fits, and `next` goes on from there. A caller whose answer travels in a bounded message names its room this way; a door answers a run within one MCP message of 65,536 bytes that carries the answer twice.
- The documents of a page are read `reads_at_once` at a time (32).

### Whole document text, kept with the same rows

`content: true` adds the complete original UTF-8 document, including frontmatter, without replacing the document's metadata or parent row ID. A document up to one piece appears as one row. Longer documents continue as stable linked child rows in the same source/list; each piece is bounded independently, so a large document never becomes a silently clipped field or an oversized single record.

The defaults are DATA in `document-properties.json` and can be overridden by a `content` object:

| Option | Default | Meaning |
|---|---|---|
| `field` | `document.text` | Exact UTF-8 text of this piece. |
| `parent_field` | `document.parent` | The original document row ID, on every piece. |
| `index_field` | `document.part` | One-based piece number. |
| `count_field` | `document.parts` | Total pieces required for the complete document. |
| `complete_field` | `document.complete` | `complete` for a whole single-piece document, otherwise `part of document`. |
| `part_bytes` | 12000 | Nominal bytes per piece; a UTF-8 boundary moves forward by up to three bytes so no character is cut. |
| `source_field` | `document.source` | Original file parent of a virtual section. |
| `section_field` | `document.section` | Semantic section ID, or `remainder`. |
| `offset_field` | `document.offset` | Original UTF-8 byte offset of the text piece. |
| `sections` | null | Optional existing `splitDocuments` heading/row mapping for maintained virtual section rows. |
| `omit_fields` | [] | Explicitly omit only DATA-declared regenerable derived caches, such as `file.links`; default callers keep every field. Original frontmatter, source bytes, identity and path cannot be omitted. |

The first piece keeps the original `/folder/name.md` ID. Later IDs are `/folder/name.md#text-part-00000002`, and so on. All current frontmatter and file facts are kept. Reconstruct a document only after checking that its identity, part count and every consecutive part number agree, then join the text in part order. A list refresh can remove obsolete trailing child rows through its existing exact-source removal scope when a document becomes shorter.

With content enabled, `limit` and `most_bytes` bound the emitted rows and the complete answer, including child rows. Pass `next` back unchanged: an unfinished document uses an opaque cursor pinned to its identity. A document changed between pages is refused, so text from two edits is never joined. The Namespace source reads the same pieces through the existing files door by name and checks the identity on every byte page. Invalid UTF-8 and incomplete byte ranges are refused. No file-content reference or local path is substituted for missing text.

By hand, add `--content` (or `--content '<options JSON>'`) and optionally `--most-bytes N` to `rows`. Existing metadata-only callers are unchanged.

With `content.sections`, the existing splitter exposes original source spans before presentation formatting or equal-word merging. The original file parent remains as metadata, with part number zero and no duplicate full body. Stable `#section-<id>` rows carry each section's exact original bytes; `#remainder-<offset>` rows retain everything outside sections. Repeated section IDs get an explicit occurrence suffix. Bounded child pieces still link to their section parent. To reconstruct the original file, take rows with a positive part number, order them by `document.offset`, and join their text. Headings, blank lines and repeated words remain exact. The normal split API is unchanged unless `raw_segments` is requested; that option adds `{source,file,id,kind,fields,from_byte,after_byte,text}` spans and never changes its existing normalized items.

Measured on 2026-10-30 at load 80 to 98 on 18 cores, one page of 50 rows, including Node's start of about 0.44 s at that load:
- A folder of about 200 documents: 0.5 s.
- A folder of about 3,000 documents: 1.4 s.
- A tree of about 220 `*/SKILL.md` documents, one per sub-folder: 1.4 s.

## Changing a field

`changeDocumentRows({ root, folder?, rows: [{ id, values: { 'note.<key>': value | null }, if_identity? }] })` rewrites only the frontmatter lines of the keys named:
- A value of `null` removes the key.
- Other keys, comments and the body stay byte for byte.

Kinds and conflicts:
- A value must fit the kind the folder's `property-types.json` gives the property. File facts and formulas are worked out and cannot be written.
- When `if_identity` is given and the document changed since, the change is refused.
- Without `if_identity`, a document that changed meanwhile has the change made again on what it now says.

Writing:
- The new bytes are written and synced beside the document and renamed over it, so a reader sees the old document or the new one.
- The answer is each changed document's new values and identity.

## Frontmatter

The YAML block between the first two `---` lines.

What is read:
- `key: value` lines whose value is a JSON value, a quoted or plain scalar, or a `[a, b]` list.
- `key:` followed by `- item` lines.
- A key holding anything else (a nested mapping) is read as its text, and it is kept as written when another key changes.

What is written is the same subset: plain words when unambiguous, JSON-quoted text otherwise, and `- item` lists.

## Splitting a long document

`splitIntoDocuments({ root, mapping, out?, leftover?, check? })` reads the documents a mapping names (relative to `root`) and writes `<out>/<id>.md` for every item. Each written document has frontmatter (`id`, then the fields) and the item's parts under `##` headings. Each document's text that belongs to no item goes to `<leftover>/<source name>.md`. `check` reports and writes nothing. The code knows no item kind: the mapping names everything (the keys are at the top of `read-data/split.mjs`).

| Key | Holds |
|---|---|
| `sources` | `[{ name, file }]`: the documents. A later one adds to the items of an earlier one. |
| `heading` | A regular expression for a heading line that starts an item. Named group `id` is required; other named groups are fields. The item runs until the next heading of its level or higher. Its sub-headings stay in it, and so does a `#` line inside a code fence. |
| `row` | A regular expression for a table line that is an item. Group `id` is required, group `text` is the row's words, and other named groups are fields. |
| `group_heading` | Optional. A heading whose named group sets that field on the rows under it, for example `## Level 2` gives `level: 2`. |
| `flags` | Optional. `{ field: [WORD, ...] }`: the words found in an item's text become a list field. |
| `first_sentence_when_missing` | Optional. A field that no piece names gets the first sentence of a row's words. |
| `prefer` | `["<source>:<kind>", ...]`: whose field wins, first first. The kinds are `section`, `row` and `grouped-row`. |
| `parts` | `{ "<source>:<kind>": "<heading>" }`: the heading each kind of piece is written under, in this order. |
| `field_order`, `order_by` | Optional. The frontmatter order of the fields, and a regular expression whose one group of digits orders the items. |

Nothing is dropped:
- The lines read and the lines placed must agree.
- A piece whose words, apart from spacing, equal another piece's is written once, and the report counts those merges.
- The split refuses an `out` folder that is not empty.

### A JSON list

A mapping with `items_at` splits JSON documents instead. Each item of the list at that dotted path becomes one document.

| Key | Holds |
|---|---|
| `sources` | `[{ name, file }]`: the JSON documents. |
| `items_at` | Where the list is, as a dotted path. |
| `id` | The item's id: `{field}` is the value of one of its fields, and `{#}` is its place in the list, counted from 1 and padded to the list's width. An id with a slash, and two items with one id, are refused. |
| `parts` | Optional. `{ field: "<heading>" }`: fields written as text under a heading instead of in the frontmatter. |
| `field_order`, `order_by` | As above. |

Where each value goes:
- A value that is text, a number, true or false, or a list of those, goes in the frontmatter.
- Any other value (an object, or a list of objects) is written under a heading of its own name, as JSON. Nothing of an item is dropped.
- Each document without its list is kept in `<leftover>/<name>.json`.
- The report counts the items read and the items written, and the two must agree.

## Files

| File | Purpose |
|---|---|
| `read-data/document-properties.mjs` | Frontmatter, links and tags, the property-types sidecar, and the `documents` row source: a page of rows, field kinds, and the conditional property write. |
| `read-data/document-properties.json` | The source's DATA: namespaces, sidecar name, kinds, file facts, link and tag syntaxes, bounds and refusal words. |
| `read-data/folder-files.mjs` | The `files` of one folder on the person's computer: names only in a listing, bytes with their identity, and the identity-checked write. |
| `read-data/namespace-files.mjs` | The `files` of the person's Namespace, through the run's records door: names from list_files, bytes from read_file by name; no write. |
| `read-data/split.mjs` | Splitting documents into one document per item by a mapping. |
| `read-data/rows.mjs` | The functions the rows run: `readDocumentRows`, `changeDocumentRows`, `splitIntoDocuments`. |
| `do-work/documents.mjs` | The command line above. |
| `test/documents-as-list-rows.test.mjs` | All of it on made-up chores and house rules. |

## Dependencies

**Depends on:** Node, `tools/content-identity` (BLAKE3 identities, with `@noble/hashes`), and for the Namespace row `tools/records-door` (`run-an-export.mjs` and its `door.files`).

**Depended on by:** a list whose `row_sources` names the `documents` source.
