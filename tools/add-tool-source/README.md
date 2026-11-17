# tools/add-tool-source/

Adds a source of tools from one address. A source is a folder, a git repository at any host or a remote MCP server, and its kind is a stored fact this tool learns once and writes down with how it learned it (`syntax` or `probe`); the person never types a kind. One row, `tool:add-tool-source`.

The order is the owner's decision case `source:a2VlcC1vbmx5LWJyaWFucy1kYXRhLWFuZC13aXBlLXRoZS1ib3hlcy0yMDI2LTExLTE2` (tool sources of any kind): the address's own syntax first (an explicit prefix, a path, a listed git host in `read-data/add-tool-source.json`), then, only for a bare https address, one probe of an MCP `initialize` and a git `info/refs`. An address that is neither, or both, is refused in one plain line that says what to write instead. The probe sends no credential, follows at most three redirects each to https, reads at most 64 KiB, and goes only where the run's egress lets it (a private address is not reached); a server of the person's own at a private address is written `mcp+http://host:port/path`. A repository starts at the commit its server names as HEAD now.

It adds nothing itself. It keeps one pending request for the person (`record:tool-source-request:<label>`: a question, never a list of sources, deleted by the screen that asks the person when they approve or decline), and the engine's own list of the account's sources, read with `tools:sources`, and hands back the entry and the call that adds it: the engine's `tools:add-source` at `@tools`, which the door lets only a fresh sign-in of the person make (trillion-rust `src/account/signed_in/settings.json` `needs_person`). The engine's list of the account's sources in its state folder is the one original; each added source starts with an empty grant (trillion-rust `src/tool_runs/tools/added_sources.rs`).

A server that asks for a sign-in (a 401 that names its sign-in document) is signed in to as the Model Context Protocol describes (`do-work/sign-in.mjs`): discovery (RFC 9728, RFC 8414 or OpenID), registration of this caller as a public client (RFC 7591), PKCE S256 and the server named as the resource (RFC 8707). The answer carries the address to sign in at; the person signs in there, the sign-in tool's page hands `{state, code}` back as `callback`, and `tool:trade-a-tool-servers-sign-in-code-for-its-tokens` (an http row) trades the code and keeps the access and refresh tokens in the person's vault as the fields of the connection `service_connection:tool-server:<label>`. The request for approval then carries `remote.sign_in {token_url, client_id}`, the one address the engine refreshes the token at (trillion-rust `remote_mcp.rs`); the engine refreshes on a 401 and writes the rotated pair back. The page the person returns to is DATA (`sign_in.redirect_uri`), never an input. A client-id metadata document is not used: it needs a hosted document at a fixed address.

## Files

| File | Purpose |
|------|---------|
| `do-work/add-tool-source.mjs` | `addToolSource(input, { door, fetch })`: learns the kind, makes the engine's entry, keeps the row; the one export the row runs |
| `do-work/sign-in.mjs` | discovery, registration, PKCE, the pending sign-in and its finish |
| `do-work/ask-the-web.mjs` | the one bounded, credential-free request and read the probe and the sign-in share |
| `read-data/add-tool-source.json` | DATA: the prefix table, the git hosts and where each serves a commit's archive, the probe's bounds with their why, the row's kind and every word the tool says |
| `tool-rows.json` | The rows `tool:add-tool-source` (its egress, its request right and its pending sign-in right) and `tool:trade-a-tool-servers-sign-in-code-for-its-tokens` |
| `kits/add-tool-source.json` | The kit that says how to ask for it and what comes back |
| `test/add-tool-source.test.mjs` | Syntax, listed hosts, nested groups, MCP by json, by stream and by sign-in, git by refs, neither, both, a private address, a hang, a password, redirects, and the one row kept |

## Dependencies

**Depends on:** `tools/records-door` (`list`, `write`); the engine's `tools:add-source` (trillion-rust `src/tool_runs/tools.rs` `add_source`) for the person's approval.

**Depended on by:** nothing.
