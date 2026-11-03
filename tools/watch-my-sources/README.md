# tools/watch-my-sources/

Watch my sources: the places a person follows (any site's feed, a YouTube channel, a blog, a changelog, a page, a best-seller or trending list) are rows of their own list `signal-sources`, read each run. Every item not kept before becomes a row of their list `signals`; a source's first read is a quiet baseline; what is new is weighed against what they pursue and the content formats they use, in one question a run; only what moves a pursuit, directly or as an insight from another field, is handed to their AIs through their arrival door. The rest is set aside with why. A ranked list keeps each item's rank in `ranked-items` and makes one signal of each entry, climb, fall or drop-out. Nothing here names a site: a source is a row, a new kind of source or a new ranked-list reader is a row of `read-data/watch-sources.json`.

Moved from Trillion-X/trillion (commit 2e57d9a49ba0eb2ff3a44fa711be1ff054e32b18): `src/watch-sources.mjs`, `src/watch-sources.json`, `src/ranked-lists.mjs` and `src/feed-items.mjs`, with `test/watch-sources.test.mjs` rewritten on made-up pages. `ports/watch-sources.json` is the port contract naming each source and its identity. This folder holds the one copy: Trillion's own in-account run imports `read-data/watch-sources.mjs` from this package and hands it the person's lists, model routes and arrival door.

## How it runs

`tool:watch-my-sources` runs `do-work/watch-my-sources.mjs` `watchMySources` in a small container through the person's records door (`tools/records-door`):

- The lists are records, as a Trillion list keeps them: the list `list:<id>` (type `list`) and each row `record:<row type>:<row id>` (type `record:<row type>`), reached by `tools/records-door/read-data/lists-door.mjs`. A row is merged, never replaced; every write expects what was read, so a row changed by someone else in between refuses the write and nothing of it is kept.
- Pursuits are the person's `pursuit` records; content formats come in as `formats` (the caller reads them with content_formats).
- The run asks no model and hands nothing in itself. When new items wait it answers `weigh_wanted` `{ purpose: "signal-weigh", identity, messages, max_tokens }`, the question for the oldest batch, byte for byte the same until it is answered; the AI that runs the tool answers it and runs again with `weighed` `{ identity, reply }`. A reply is used only for the question its identity names. Each item that moves a pursuit comes back in `arrivals`, each exactly what the arrival door takes (route `watch-sources`, `from_person: false`, `source_id`); the door keeps one arrival per route and source_id, so handing one in again adds nothing.
- A source whose Take in is Whole history is named under `history_wanted` with the tool that lists it; that tool's answer comes back as `history` `{ source, answer }`.

The row's rights are the three lists and their rows, and listing `pursuit`; it reads only public addresses and writes nothing anywhere else.

## Files

| File | Purpose |
|------|---------|
| `read-data/watch-sources.mjs` | `watchSources({ lists, read, pursuits, formats, ask, arrive, now }, input)`: one run over any `lists` (answered at once or as promises). |
| `read-data/watch-sources.json` | The lists it makes (fields, choices, the starter places, each off), run limits, the arrival route, the weighing question, ranked-list readers, history tools and every refusal's words, as DATA. |
| `read-data/feed-items.mjs` | One reader for every address followed: RSS, Atom, JSON items, a YouTube channel's videos page, and the bounded conditional read (ETag, Last-Modified, 304). |
| `read-data/ranked-lists.mjs` | A ranked list read whole by its reader row, and how an item moved between two days. |
| `do-work/watch-my-sources.mjs` | `watchMySources(input, { door })`: the tool's run, with the weighing and hand-in answered for the caller. |
| `ports/watch-sources.json` | The port contract: the Trillion sources, their BLAKE3 identities and the baseline copy. |
| `tool-rows.json` | The Workshop row. |
| `part.json` | Public files. |
| `test/watch-sources.test.mjs` | The moved tests: feeds, pages, YouTube, X, 304, caps, the held question, history, ranked lists, one read and one write a run, over lists behind an in-memory door. |
| `test/watch-my-sources.test.mjs` | The tool's run: the weighing hand-off, arrivals, pursuits from records, starter places, and the row run through the records door with its rights. |
| `test/memory-door.mjs` | The records door in memory, with its write conditions. |

## Dependencies

**Depends on:** `tools/browse-public-page` (`do-work/page-facts.mjs`: the public-address check and a page's readable text), `tools/records-door`, `tools/content-identity`, `@noble/hashes` (BLAKE3).

**Depended on by:** Trillion-X/trillion (its in-account run of Watch my sources, and its list filled from a feed, which reads feeds with `read-data/feed-items.mjs`).
