# tools/install-a-tool-source/

Installs on this computer the tool source one of the person's rows names, or takes it away when the row was removed. It is the one step of the person's own workflow that keeps every computer of theirs on what their rows say each tool source is: a source is any https archive of tool folders (a teammate's as well as the Workshop's), pinned by its files, and no computer needs a hand step of its own.

## How it works

The person keeps their tool sources as rows in their own database (one row per source: its label, the archive's address and the pin of its files). A row-changes waiter tells the engine each change, and the workflow whose condition matches a change in that table runs this tool with the row's fields. The tool calls the engine's `tools:update` at the Workshop's address. A new label becomes a new source, the same label moves to the new pin, and `removed: true` takes the source away (trillion-rust src/tool_runs/tools/tool-runs.json `update_method`, src/tool_runs/tools/install.rs `remove`).

The run may install only because its row declares the right `{at: "@tools", id: "*", operations: ["tools:update"]}`. `*` names every source, since a shared row cannot know a person's labels (trillion-rust run_rules.rs `names_by_prefix`). The person grants it by switching on the wake that runs it.

| File | Purpose |
|------|---------|
| `do-work/install-a-tool-source.mjs` | `installToolSource(input, { door })`: checks the input is one source to install or take away, then sends `tools:update` to `door.toolsAddress` under a request key made from the label and the pin, and answers the engine's answer with the label. `problemOf(input)` says why an input is refused. |
| `do-work/install-a-tool-source.json` | How the keeper waits while the engine is already installing for this account (one install per account at a time): the refusal's code, the first wait, its growth and the most asks. |
| `tool-rows.json` | `tool:install-a-tool-source`, a container row run by `records-door/do-work/run-an-export.mjs`, with the one install right. |
| `test/install-a-tool-source.test.mjs` | An install and a removal reach the Workshop's address with their keys; a bad input is refused before the door; the records door sends an operation to the address it names. |
| `kits/install-a-tool-source.json` | How a person asks for it. |
