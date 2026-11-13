# tools/bring-in-new-items-from-this-computer/

Brings in what is new in each place on the person's computer (a notes store, a recordings store and its files, a chat
database, a calendar, a folder of downloads or pictures, a carried conversation, the address book) and sends it to their
account's one door, where each arrival is kept as one of the account's own rows. Every place, a store on a computer or a
connected service, is a row of the account's list `inputs`; one generic reader reads any place its row describes, so a
place on any computer (macOS, Windows, Linux) or a service is one more row and never code. `computer/computer-sources.json`
`sources` are only the rows the list starts with, copied in once when the list is made.

Moved here from Trillion-X/trillion's `computer/` by `tools/move-code-between-trees`
(`move-rows/trillion-computer-places-to-workshop.json`); `moved-from.json` names each file's source path and commit and
the identity of its bytes there and here. The folder keeps the source tree's own paths under it, so the files import
each other as they did. Trillion-X/trillion's computer helper (`computer/read-this-computer.mjs`, which runs the looks,
and the modules beside it that read the same rows) now lives in `tools/run-on-a-persons-computer` and reads these
files from here; it holds no copy of its own.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:look-for-the-places-on-this-computer` | One look (`computer-sources.mjs` `lookHere`) at the places the rows list, under the folder the person granted for reading (`read-a-folder`, their home folder): each is found, needs its switch, or is left out; a place only outside that folder (an app in `/Applications`, a drive) is `could_not_check` with the reason, never looked for | on the person's computer, at its local door's `tools:run` |

The one Connections list, services and these places together, is `tool:list-every-connection` in
`tools/connect-a-service-and-seal-its-key`, which reads this folder's place rows and can take this tool's answer.

## The inputs list

`computer/inputs.mjs` is how the reader reaches the list `inputs` (`computer/inputs-list.json` is its definition) through
the person's records door: it makes the list once with `computer-sources.json`'s `sources` as its starting rows (a row the
person later removes or changes is never put back), reads the rows back as the places the reader looks at and reads (at most
once in `inputs.every_seconds`), and keeps the last rows it saw (`inputs-cache.json` in the computer's progress folder) so a
Mac that cannot reach the account goes on reading what it read. The list is made first, then each starting row not there yet, then the list is marked `seeded`, so a first run cut off in between goes on from where it stopped and a row removed after the mark is never put back. Two rows with one `read.route` are not both read (the first is; the log names the other), and a place not read, or failing to be read, for `inputs.warn_after_hours` (24, or the row's own `warn_after_hours`) carries a `warning` in its status, which the report to Connections includes and which takes the place out of `reading`. A row's `reading` set to No leaves the place listed (Connections
shows it) and unread. A service row names its connection by handle (`connection`) and never holds a secret.

A connected service is read by the `tool` reader, in the reader's own process: the row names a Workshop tool (`tool`), its
`input` (strings filled with `{since}`, `{since_seconds}`, `{since_ms}`), where the list of new things is in the tool's answer
(`items`), which field of a thing is its id, time, title and words (`fields`), the time unit (`time`: `iso`, `unix-seconds` or
`unix-ms`) and, in place of a words field, a `text` template over the thing's top-level values. Nothing in the code names a
service. Added by writing one row of `inputs`, for example (a made-up service):

```json
{"label": "Madeup Notes", "category": "Notes", "connection": "service_connection:madeup-notes",
 "read": {"route": "Madeup Notes", "reader": "tool", "tool": "tool:madeup-notes-list-changed",
          "input": {"connection": {"connection_id": "service_connection:madeup-notes"}, "changed_since": "{since}"},
          "items": "notes", "time": "unix-seconds", "fields": {"source_id": "id", "at": "changed", "title": "name", "text": "body"},
          "settle_seconds": 0}}
```

## A place is a row

A row's `read` block names its `route` (how Connections and the door call the place), its `reader` and `store`, how long
an item must be unchanged before it goes (`settle_seconds`), and the reader's own fields. The readers (`READERS` in
`computer/read-new-items.mjs`) know a kind of store, never an app:

| Reader | Reads | The row says |
|--------|-------|--------------|
| `sqlite` | any SQLite store | `query` (or a list of queries, the first the store's columns answer), with `:since`, `:before` and `:limit` in the row's `time` unit (`seconds-since-2001`, `unix-seconds`); `decode` steps for a column kept in its own format (`typedstream-string`, `gzip-protobuf-text` with its field `path`); `text` (a template); `skip` (`{column: [values]}`); `file` (where the item's picture, video or recording is, relative to `files_from`; `required` makes an item wait until its file is on this computer) |
| `folder` | the files added to a folder | `names_containing`, `skip_endings`, `text` |
| `incoming` | what a carried connection kept (`computer/connections/incoming-items.mjs`) | the journal's `store` |

The notes place is a `sqlite` row whose query leaves out locked, deleted and binned notes and whose `gzip-protobuf-text`
decoder reads a note's words at field path 2, 3, 2; the recordings place is a `sqlite` row whose query builds the
memo's words and file name and whose `file.video` finds the recording beside the store. Their app names are in their
rows only.

Every wait and word the reader keeps is DATA in the same file: `pace` (how often to look, following power and
idleness), `turned_away` (how long an item the door turned away waits alone), `item_trouble` (how long an item whose
file the account would not keep waits, doubling), `long_text` (words past this go whole as a text file), `hearing` and
`seeing` rows (which program hears a recording or reads a picture on this computer), `gates` (the switch a store
needs and the pane that grants it), and `programs`: every program a look or a read starts, by its job
(`picture_sides`, `picture_preview`, `picture_copy`, `picture_copy_shrunk`, `open_address`, `app_facts`,
`computer_name`), each a list of tries; `programRun` runs the first whose program is on this computer, and a job with no
try here is skipped (no preview, no pane, the host name for the computer's name). The code names no program. `computer/read-new-items.json` caps the reader child processes.

## Files

| File | Purpose |
|------|---------|
| `computer/read-new-items.mjs` | The readers and `readNewItems`: settle, send once per version, group per window, preview and copy pictures, hear a recording and read a picture before sending, back-fill the past newest first, and each place's and each item's waits. |
| `computer/read-new-items.json` | How many reader child processes run at once and how long a read waits for one. |
| `computer/computer-sources.json` | The rows the `inputs` list starts with, and every wait and word the reader keeps. |
| `computer/inputs.mjs` | The `inputs` list as the reader reaches it (`liveInputs`, `startersOf`), and the `tool` reader for a connected service (`serviceReader`, `toolRunner`, `readersWith`). |
| `computer/inputs-list.json` | The list's definition: its fields and what a row holds. |
| `test/inputs-are-rows.test.mjs` | The list is made once, a removed row stays removed, a paused row is unread, an unreachable account keeps the last rows, and a made-up service added as one row arrives once each. |
| `computer/computer-sources.mjs` | Finds which places are on this computer and which need a switch (`look`), `placesOf` for a store with wildcards, `accessPaneAddress`, and `programRun` / `openAddress` (the `programs` rows). |
| `do-work/look-at-this-computer.mjs` | The run of `tool:look-for-the-places-on-this-computer`: one look confined to the granted folder. |
| `tool-rows.json` | That row. |
| `computer/own-writes.mjs`, `own-writes.json` | Paths Trillion's own work just wrote, so a folder read does not send them back as new. |
| `computer/connections/` | The carried conversations (`imessage.mjs`, `whatsapp.mjs`) and the journal they keep what arrives in (`incoming-items.mjs`). WhatsApp loads `@whiskeysockets/baileys`, an optional peer the computer that carries it installs. |
| `computer/sync-contacts.zsh`, `sync-contacts.js`, `sync-contacts.json` | Sends the address book to the person's people list. The Mac Contacts setup line (its descriptor in `tools/connect-a-service-and-seal-its-key/records.json`) downloads these three files from this folder in the public Workshop. |
| `test/places-are-rows.test.mjs` | Made-up notes and recordings stores and a folder of pictures, read only through their rows: each new item arrives once as a row of a stand-in account, a turned-away item waits alone, a recording waits for its file, the past is read newest first. |
| `test/programs-are-rows.test.mjs` | Stand-in programs answer the `programs` rows: a preview and a copy (shrunk only past its edge), a pane, an app's facts; no code file starts a program it names. |
| `test/look-at-this-computer.test.mjs` | The row's sample run through `test-helpers/run-a-row.mjs`, and a look that never leaves the granted folder. |
| `test/*.test.mjs` | The reader's own tests, moved with it. |

## Not yet proved on a computer

- `tool:look-for-the-places-on-this-computer` run at a real computer's local door, and the `programs` rows on a Mac
  (`sips`, `open`, `plutil`, `scutil`): the sample run and the stand-in programs prove them here; three of the moved
  tests (`computer-sources-on-a-computer`, `read-new-photos-video`) still need macOS's own look tools to pass.
