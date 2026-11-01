# Import Markdown as an editable document

This tool imports Markdown into the same composition scene tree consumed by the editable Documents owner. It reuses the maintained importer, the declared editing rules, and the Markdown interchange projection. Headings, nested ordered and unordered lists, task items, tables, fenced code, quotes, links, images, and inline marks retain their editable meaning.

The result includes source token provenance with UTF-8 byte spans into the original input. Each span is checked against the exact source bytes. A separate maintained export/import round trip checks the complete scene tree by its canonical revision identity; Markdown formatting may be canonicalized, so this is not a claim that output bytes equal input bytes.

Container calls are bounded to 500,000 input bytes and 240,000 output bytes. For larger outputs, use `do-work/import-markdown-file.mjs` with a folder grant. The adapter reads a stable UTF-8 source file inside that folder, parses it with the same importer, and creates a new JSON artifact using exclusive mode `0600`; it returns a small summary so the scene tree does not need to fit in native tool output. It refuses paths outside the granted folder, replacement of an existing output, changing source files, invalid UTF-8, and inputs over 500,000 bytes.

Run from the Workshop root with one JSON request on stdin:

```sh
printf '%s' '{"markdown":"# Example\n\nText.\n"}' | node tools/import-markdown-to-editable-document/do-work/import-markdown.mjs
```

`read-data/editing-rules.json` and `read-data/document-import-formats.json` are the maintained DATA snapshots used by the importer. The content identity function is imported from `tools/content-identity`, and `marked` is a declared dependency.

File adapter request (all three paths must be supplied by the host's folder grant):

```json
{"granted_folder":"/granted/folder","source_path":"/granted/folder/source.md","output_path":"/granted/folder/import.json"}
```

Run it with one JSON request on stdin: `node tools/import-markdown-to-editable-document/do-work/import-markdown-file.mjs`.
