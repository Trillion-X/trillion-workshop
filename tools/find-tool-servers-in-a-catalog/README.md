# Find tool servers in a catalog

Finds tool servers for a job in a published catalog, and gives the address to call each one at.

## What it does

`tool:find-tool-servers-in-a-catalog` takes `words` (like "email inboxes") and answers the servers a catalog lists for them:
name, title, what it does, whether it is still active, the headers it asks for (a key to connect first) and its `address`.
Give that address to `tools:list {address}` or `tools:run {address, tool}` to see and use the server's tools. A server
with no address runs only as a program on a computer.

The catalog is data: `read-data/catalogs.json` names the default, the MCP registry's own list
(https://registry.modelcontextprotocol.io/v0/servers), and a call may name any other catalog that speaks the same API.
Nothing is kept and no key is sent: the catalog is read as it is at the moment of the call.

## Words

A server is listed when every word is in its name, title or description, in any case (the rule `tools:list` uses for its
own `words`). The registry's own search matches one text against names only, so each word is asked of the catalog and
the servers holding every word are kept. A one-word search pages with the catalog's own cursor (`next_cursor`).

## Files

| File | What it is |
|---|---|
| `do-work/find-tool-servers.mjs` | The program the tool row runs: reads the input on standard input and prints the answer. |
| `read-data/catalogs.json` | The default catalog, the remote kinds an address may be, and the page sizes. |
| `test/find-tool-servers.test.mjs` | Tests with recorded catalog replies. |
| `tool-rows.json` | The tool's row. |
