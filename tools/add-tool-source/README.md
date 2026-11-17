# tools/add-tool-source/

Adds a source of tools from one address. A source is a folder, a git repository at any host or a remote MCP server, and its kind is a stored fact this tool learns once and writes down with how it learned it (`syntax` or `probe`); the person never types a kind. One row, `tool:add-tool-source`.

The order is the owner's decision case `source:a2VlcC1vbmx5LWJyaWFucy1kYXRhLWFuZC13aXBlLXRoZS1ib3hlcy0yMDI2LTExLTE2` (tool sources of any kind): the address's own syntax first (an explicit prefix, a path, a listed git host in `read-data/add-tool-source.json`), then, only for a bare https address, one probe of an MCP `initialize` and a git `info/refs`. An address that is neither, or both, is refused in one plain line that says what to write instead. The probe sends no credential, follows at most three redirects each to https, reads at most 64 KiB, and goes only where the run's egress lets it (a private address is not reached); a server of the person's own at a private address is written `mcp+http://host:port/path`. A repository starts at the commit its server names as HEAD now.

It adds nothing itself. It keeps one row of the person's list of tool sources (`record:tool-source:<label>`, waiting for approval) and hands back the entry and the call that adds it: the engine's `tools:add-source` at `@tools`, which the door lets only a fresh sign-in of the person make (trillion-rust `src/account/signed_in/settings.json` `needs_person`). The engine keeps the added sources in the account's state folder and starts each with an empty grant (trillion-rust `src/tool_runs/tools/added_sources.rs`).

## Files

| File | Purpose |
|------|---------|
| `do-work/add-tool-source.mjs` | `addToolSource(input, { door, fetch })`: learns the kind, makes the engine's entry, keeps the row; the one export the row runs |
| `read-data/add-tool-source.json` | DATA: the prefix table, the git hosts and where each serves a commit's archive, the probe's bounds with their why, the row's kind and every word the tool says |
| `tool-rows.json` | The row `tool:add-tool-source`, its egress and its one record right (`record:tool-source:`) |
| `kits/add-tool-source.json` | The kit that says how to ask for it and what comes back |
| `test/add-tool-source.test.mjs` | Syntax, listed hosts, nested groups, MCP by json, by stream and by sign-in, git by refs, neither, both, a private address, a hang, a password, redirects, and the one row kept |

## Dependencies

**Depends on:** `tools/records-door` (`list`, `write`); the engine's `tools:add-source` (trillion-rust `src/tool_runs/tools.rs` `add_source`) for the person's approval.

**Depended on by:** nothing.
