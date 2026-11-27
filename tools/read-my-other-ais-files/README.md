# tools/read-my-other-ais-files/

Lets the person's AIs read the instruction, command, skill and MCP-server files the person already keeps for their other AI apps (Claude Code, Codex, Cursor, Claude Desktop, Gemini CLI, Windsurf), in place and labelled by the app they belong to, instead of the person copying them. It runs on the person's own computer as a `computer` row over the folder they granted (their home folder). Read only: nothing is written into those folders and nothing is imported.

## Files

| File | Purpose |
|------|---------|
| `read-data/other-ai-files.mjs` | `otherAiEntries({ rules?, home?, only? })`: every entry the rows name that exists; `otherAiFiles(input, { rules?, home? })`: the tool; `otherAiFilesInGrantedFolder({ input, folder })`: the row's export, reading under `folder`, the folder the person granted; refused when no folder is granted. The header states the invariants. |
| `read-data/other-ai-files.json` | One row per AI app; each `places` row says the kind it holds and its shape (`file`, `files`, `skill_folders`, `mcp_servers`). A new app or folder is one more row. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:other-ai-files`: a `computer` row with the `read-a-folder` capability, run by `tools/workflows`' `do-work/run-a-function.mjs`; its stdin is `{ input, folder }`, where `folder` is the granted folder the places are read under. |
| `test/other-ai-files.test.mjs` | The listing (names, no contents, narrowed by app and kind), reading (labelled, cut long ones saying so, links never followed), unknown app or kind, MCP servers with variable names only, and the row's command run on a made-up home folder. |
| `part.json` | Nothing here is imported by other code. |

## Input and answer

| Input | Answer |
|-------|--------|
| `{ source?, kind?, read?: [entry names] }` (the row's stdin: `{ input: that, folder: granted folder }`) | `{ entries: [{ name: source/kind/entry, source, label, kind, bytes }], files?: [{ name, source, label, kind, text, said? } or { name, error }] }`, or `{ error }` for an unknown app or kind |

## Moved from

Trillion-X/trillion `computer/other-ai-files.mjs`, `computer/other-ai-files.json` and `test/other-ai-files.test.mjs`, carried whole from the last commit that held them (dc79bb0a^; dc79bb0a deleted them because no Workshop row named the tool). Its tests are carried one to one; the assertion on the old Mac host's tool table (`computer/mac-tools.json`) is now a check of this folder's row. The home folder, which the Mac host took from the operating system, is now the folder the person grants the run.

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-a-function.mjs`) and Node's standard library. It reads no door and no record: the rows it reads are the files under the granted folder.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json` only.
