# tools/write-public-share-files/

Writes the public files of a person's share links that anyone may open, into one folder a public server serves read-only under `/share/` (GET and HEAD, no listing). The person's own computer runs it whenever a link or a shared List changes, so the server never reads their records: it only serves files.

Moved from Trillion's hosted share reader, which answered these addresses itself until it was retired:

- `src/record-share-pages.mjs`: `/share/<code>.json`, `/share/<code>/files/<identity>`, `/share/<name>` and one page per List row, `/share/sitemap.xml` and `/share/llms.txt`;
- `src/record-sharing.mjs`: a link's admission (published, not revoked, not expired), the List row addresses (`listRows`, `latestDay`) and one row shared on its own;
- `src/list-copy.mjs`: `read-data/list-copy.mjs`, what of a List leaves;
- `src/person-spaces.mjs` `shareableCopy`: `read-data/shareable-copy.mjs`, the fields a record's share rule lets out;
- `src/record-sharing.json`, `src/space-settings.json` and `src/lists.json`: the rows of `read-data/share-files.json` this tool reads.

Trillion imports `read-data/list-copy.mjs`, `read-data/shareable-copy.mjs` and `do-work/share-files.mjs` from here (`part.json`), with its own field kinds, rule table and saved-view projection handed in, so one copy of this code remains.

## What it writes

Paths are relative to the folder, which the server serves as `/share/`:

| Path | Holds |
|---|---|
| `<code>.json`, and `<name>.json` when the link has a readable address | `{ kind: "list", title, about, changed, fields, rows: [{ id, title, address, url, values }], files: [{ identity, name, url, media_type }] }`: every shown row and every file they name, whole, never paged (no `has_more` or `next`). This is the shape `trillion-site/worker/shared-list.js` reads. |
| `<name>/index.html` | The List's page: its title, about and a link to each row. `<name>` is the link's readable address, else its code. |
| `<name>/<row address>/index.html` | One page per row: every shown field, its first picture, video or sound, its https links. A row's address is its title's first words, numbered when two read alike. |
| `files/<identity>` | The bytes of each file a shown row names, by its BLAKE3 identity (`1f:` and 64 hex digits), checked against that identity as it is read. |
| `sitemap.xml`, `llms.txt` | Every listed link and its rows. Over 50,000 addresses or 1,000,000 bytes, each becomes an index of parts under `sitemap/<n>.xml` and `llms/<n>.txt`. |
| `manifest.json` | `{ schema: "trillion.public-share-files/v1", origin, written_at, files: [{ path, identity, media_type }], removed }`: every file this run wrote or kept with its BLAKE3 content identity (`tools/content-identity`), and every file of the last run it removed. |

A server maps `/share/<name>` and `/share/<name>/<row>` to their `index.html`, because a file and a folder cannot share one name.

## Who sees what

- A link has files only while it is published, not revoked, not expired and open to anyone (`scope.kind: "public"`). A link for named people, an email, an audience or an access code has none.
- What leaves is the List rule of `share_from_private` less the sharing row's `leave_out`, only the rows whose own Shown when rules hold, and only the files those rows name. A rule field and any value a tool keeps on a row that the List does not show never leave.
- A link with its own condition (`when`), a field shared to match only, or a row rule that counts opens or reads the clock is left out with its reason. A file on a public server cannot check these at each open, so they are never shown unchecked.
- Only a listed link drops `noindex`, gets a canonical address and is named in `sitemap.xml` and `llms.txt`. A comparison List's evidence rows are never named there.
- Every path the last manifest names that this run did not write is removed, and the manifest is written last. Nothing of a revoked, expired, narrowed or hidden share is kept.

## When it runs

`tool:write-public-share-files` declares two wakes on the person's own records: one when a `sharing` row (a link's grant) changes and one when a `list` changes. When a published link will expire, it answers a `wake_effects` run of itself at that time, through the engine's existing wake. It has no scheduler and does not poll.

It reads through the run's records door (`records:list`, `records:read`), and reads the bytes of shared files with the files door's `read_file`. Its input is `{ origin, row_kind }`:
- `origin` is the https address the server answers on.
- `row_kind` is the one row record kind (`record:<row_type>`) the run is granted to list.

A List whose rows are another kind is left out of that folder.

## Code

- `do-work/share-files.mjs`: the pure core. It reads and writes nothing; it turns the shares into the files above.
- `do-work/write-share-files.mjs`: the thin shell. It reads through the door, writes whole files under temporary names, keeps unchanged files, removes ended ones and writes the manifest.
- `read-data/`: the moved `list-copy.mjs`, `shareable-copy.mjs` and the DATA.

## Checks

`node --test tools/write-public-share-files/test/*.test.mjs`. The tests use made-up names and `.example` addresses only.
