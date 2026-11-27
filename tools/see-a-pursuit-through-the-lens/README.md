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
in a small container and keeps nothing:

- `lens` in the input is required: the rows of the person's list `pursuit-lens` and the row `record:content-setting:pursuit-lens`
  (opening, parts, closing), which the caller's AI reads from a store (a store's own tool server) and hands in.
  `answer` is `paragraph`, `setup` or `both`.
- It reads nothing else and writes nothing. A missing or malformed lens is refused in words saying what to hand in.

## Files

| File | Purpose |
|------|---------|
| `src/pursuit-lens.mjs` | `useLens(lens)`, `lensParagraph(data?)`, `lensForSetup(data?)`, `JOINING_INTERVIEW_FILE`, `lens` (the handed-in lens). |
| `do-work/see-a-pursuit-through-the-lens.mjs` | The tool's run: the lens handed in, answered by the module. |
| `read-data/see-a-pursuit-through-the-lens.json` | Every refusal's words. |
| `test/see-a-pursuit-through-the-lens.test.mjs` | A made-up lens: the module, the tool with the lens handed in, refusals, and the row run with no records door. |
| `what-this-tool-does-and-how-to-run-it.json` | The Workshop row. |
| `part.json` | Public files, and the tree that imports them. |
