# tools/see-a-pursuit-through-the-lens/

How an AI should look at what a person is pursuing, from that person's own lens: the places to look, the parts to read
what it finds by, and rows of what to look for and what to ask or do. It answers the paragraph every AI reads when it
connects and the setup with every part and each row whole, including the joining interview (the rows marked
`joining_interview`, and the file in the person's own files where its answers are kept).

Moved from Trillion-X/trillion (commit 42aff4e9dc) by `tools/move-code-between-trees`: `src/pursuit-lens.mjs`
(`moved-from.json` names its source and both identities). Its content, `methods/pursuit-lens.json`, was not moved: it
becomes rows of the account owner's own lists through a separate import, and the module takes the lens from its
caller. This folder holds the one copy: Trillion's own in-account run imports `src/pursuit-lens.mjs` from this
package and hands it the lens it keeps (`useLens(lens)`, or each call's `data`).

## How it runs

`tool:see-a-pursuit-through-the-lens` runs `do-work/see-a-pursuit-through-the-lens.mjs` `seeAPursuitThroughTheLens`
in a small container through the person's records door (`tools/records-door`):

- The lens rows are the rows of their list `pursuit-lens` (`list:pursuit-lens`, rows `record:pursuit-lens:<id>`),
  read with `tools/records-door/read-data/lists-door.mjs`; the opening, parts and closing are the row
  `record:content-setting:pursuit-lens`. Those ids are data (`read-data/see-a-pursuit-through-the-lens.json`), named
  for the import that keeps the content as rows, which lives outside this repository; if it keeps them elsewhere they
  are corrected there and in the row's rights, which name exactly these lists and that one row.
- `lens` in the input is used instead of reading the lists. `answer` is `paragraph`, `setup` or `both`.
- It reads nothing else and writes nothing. A missing list or row is refused in words saying what to keep or hand in.

## Files

| File | Purpose |
|------|---------|
| `src/pursuit-lens.mjs` | `useLens(lens)`, `lensParagraph(data?)`, `lensForSetup(data?)`, `JOINING_INTERVIEW_FILE`, `lens` (the handed-in lens). |
| `do-work/see-a-pursuit-through-the-lens.mjs` | The tool's run: the lens from the person's lists (or handed in), answered by the module. |
| `read-data/see-a-pursuit-through-the-lens.json` | Where the lens is kept (list, row type, row id) and every refusal's words. |
| `test/see-a-pursuit-through-the-lens.test.mjs` | A made-up lens: the module, the tool over an in-memory door, refusals, and the row run with its rights. |
| `tool-rows.json` | The Workshop row. |
| `ports/read-the-lens-from-lists.json` | The port contract of the run: no older owner reads the lens from lists (its module is the moved one). |
| `part.json` | Public files, and the tree that imports them. |
