# tools/shape-a-thought-into-my-content-formats/

The content formats a person writes and speaks in (their own saved formats, then the starters every account has), the
sources from their own recordings, notes and pursuits that can fill them, a thought shaped into each format, and a
script followed as it is read. Ported from old trillion `src/content-formats.mjs` (tag
`old-trillion-before-worker-retire`), read and written through the run's records door (`tools/records-door`).

## Tools

| Tool | What it does | Records and files |
|------|--------------|-------------------|
| `tool:answer-the-content-formats-page` | The Formats page's routes: `GET`/`POST /content-formats`, `GET /content-formats/sources`, `POST /content-formats/shape`, `POST /content-formats/follow`. It answers `{ status, body }` the way the old account route did. The engine runs it as a `@workshop-routes` tool. | read and write the one `content-formats` record; list `pursuit`; list and read files under each source kind's folders |

## Files

| File | Purpose |
|------|---------|
| `read-data/content-formats.mjs` | `makeContentFormats` and `handleContentFormatsRequest` from the tag. Only their imports changed. |
| `data/content-format-starters.json` | The starter formats and writing library, copied byte for byte from the tag's `records/content-format-starters.json`. |
| `data/content-format-sources.json` | The source kinds and the before-writing job, copied byte for byte from the tag's `records/content-format-sources.json`. |
| `do-work/answer-the-content-formats-page.mjs` | The route tool. The saved list is the record `{ id: "content-formats", type: "content-formats", value: { formats } }`. Recordings and notes are the person's Namespace files. Pursuits are their `pursuit` records. |
| `test/content-formats.test.mjs` | The tag's `test/content-formats.test.mjs`, ported. |
| `test/answer-the-content-formats-page.test.mjs` | The row runs against the fake records door, with exactly its rights. |

## Not here

- The tag's `makeMarketplaceContentFormats` could replace the bundled starters and source kinds with sections
  published on the Marketplace (`src/marketplace-content-document.mjs`). This tool reads only the bundled DATA.

## Dependencies

**Depends on:** `tools/records-door`, `tools/media-composition` (caption styles),
`tools/turn-any-recording-already-in-the-persons-files` (`recording.mjs`), `tools/record-voice-and-meetings`
(`heard-words.mjs`), `tools/tweak-live-controls` (`failure.mjs`).
