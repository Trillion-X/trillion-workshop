# tools/admit-attachments-to-a-message/

How many of the files offered with a message are admitted, and which limit stopped the rest, as one pure function:
a per-turn cap, a daily quota with its reset time and an absolute size ceiling. The first files that fit are admitted
in order and the answer names the limit that bound (`size`, `per_turn` or `daily`) with the words to show the person.
A limit that is null or absent does not bind. It reads no clock, plan or network: `now` and `daily` are given.

Moved byte for byte from Trillion-X/trillion (commit b92aa549f2) by `tools/move-code-between-trees`:
`src/attachment-admission.mjs`, its limits `src/attachment-admission.json` and its test (`moved-from.json` names each
file's source and both identities). The old copy stays until its caller, Trillion's web composer
(`src/workspace/send-message.ts`), moves.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:admit-attachments-to-a-message` | `admitAttachments({ files, limits?, daily?, now? })`: accepted indexes, the files left out and why, the binding limit and its banner, and whether nothing was admitted | in a small container |

## Files

| File | Purpose |
|------|---------|
| `src/attachment-admission.mjs` | `admitAttachments`: the one admission rule. |
| `src/attachment-admission.json` | The limits and the words for each binding limit, as data. |
| `test/attachment-admission.test.mjs` | The original test: nothing binds, the per-turn cap, the daily quota with its reset, oversize files and a null limit. |
| `tool-rows.json` | The Workshop row. |
| `moved-from.json` | Where each file came from and its identities. |
| `part.json` | Public files. |
