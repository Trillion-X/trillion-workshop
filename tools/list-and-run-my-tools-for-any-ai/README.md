# tools/list-and-run-my-tools-for-any-ai/

List and run Trillion's tools for any AI app over the standard tool protocol, locally or on the hosted web address.

The save, publish and unpublish tools have their rows in `what-this-tool-does-and-how-to-run-it.json`. `do-work/delete-tool.mjs` (deleteTool) has no tool row yet, so it is not exposed as a tool; the same holds for `do-work/publish-screen-rows.mjs` (publishScreenRows). Its old source is held, byte for byte, in `source-baselines/` (`tools.mjs.held`, the old 82-tool MCP list and run file, and `tools-batch.test.mjs.held`). `moved-from.json` names the tag and the old paths. Wiring it means adapting those bytes into this tool's own do-work/ and read-data/ parts, in a commit that names `moved-from.json`.
