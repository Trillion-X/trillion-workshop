# tools/bring-in-new-items-from-this-computer/

Brings in what is new in each place on the person's computer (a notes store, a recordings store and its files, a chat
database, a calendar, a folder of downloads or pictures, a carried conversation, the address book) and sends it to their
account's one door, where each arrival is kept as one of the account's own rows. Every place is a row of
`computer/computer-sources.json`; one generic reader reads any place its row describes, so a place on any computer
(macOS, Windows, Linux) is one more row and never code.

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
| `computer/computer-sources.json` | Every place and its rules, as rows. |
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
