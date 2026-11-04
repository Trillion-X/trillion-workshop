# tools/suggest-connections-from-links/

Which connections the links in some words point at. A link to a service the person has not connected is a reason to offer connecting it right there: the web address names the service by the `domain` its connection row declares (`invoke.connects.domain`). A link matches a domain when its host is that domain or a name under it; the longest matching domain wins, and services that share it are all named. It only proposes: connecting stays the person's own step. Pure: no reads, no clock.

Moved byte for byte from Trillion-X/trillion (commit b92aa549f2) by `tools/move-code-between-trees`: `src/connection-links.mjs` (`moved-from.json` names each file's source and both identities). The old copy stays until its caller, Trillion's connection recommendations (`src/connection-recommendations.mjs`), moves. `test/connection-links.test.mjs` here is the old test's first case, unchanged; its second (the Connections screen ranking) stays with that screen.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:suggest-connections-from-links` | The hosts in some words and each not-yet-connected service a link names, with the reason in words | in a small container, no internet |

## Files

| File | Purpose |
|------|---------|
| `src/connection-links.mjs` | `hostsIn`, `providersForLinks`. |
| `do-work/suggest-connections.mjs` | The row's run. |
| `test/connection-links.test.mjs` | The original test of the module. |
| `test/suggest-connections.test.mjs` | The row's run. |
| `tool-rows.json` | The Workshop row. |
| `moved-from.json` | Where each moved file came from and its identities. |
| `part.json` | Public files. |
