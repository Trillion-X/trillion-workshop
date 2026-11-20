# tools/list-and-run-my-tools-for-any-ai/

List and run Trillion's tools for any AI app over the standard tool protocol, locally or on the hosted web address.

This folder has no tool row yet. Its old Trillion source is held, byte for byte, in `source-baselines/` (`tools.mjs.held`, the old 82-tool MCP list and run file, and `tools-batch.test.mjs.held`). `moved-from.json` names the tag and the old paths. Wiring it means adapting those bytes into this tool's own do-work/ and read-data/ parts, in a commit that names `moved-from.json`.
