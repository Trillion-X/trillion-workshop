# tools/follow-my-ai-command-line-runs/

What a person's computer adds around one run of their own AI command line (Claude Code, Codex): the run's live events, normalised from that command line's own JSON stream to `text`, `thinking`, `tool_start`, `tool_done` and `reply` and kept as one bounded progress file; and the tools the person allows that AI in one workspace folder, passed as the command line's own allow-list flag. Moved from Trillion-X/trillion `harness/session-runs.mjs` (record:library:rea:F-0573), with the two settings-file functions of `harness/chosen-ai.mjs` it used and the allow-list branch of `harness/wake-sessions.mjs`.

- **Nothing here names a command line or an event.** The flags, where they go and the event map are rows of `read-data/ai-command-lines.json`.
- **Nothing widens permissions by default.** A folder with no list runs with the command line's own permission rules; a command line with no allow-list flag is answered as not applying. The list is the person's own and kept only for a folder that exists.
- **Reading never changes the run.** A line that is not JSON or matches no row is ignored. The progress file keeps counts, the last tool's name and at most `show_text_characters` of the kinds in `show_text` (thinking text is never kept), written at most every `progress_every_ms` and once more at the end.

Starting the run itself (the helper that wakes a session on a message) stays with the Mac helper of the old repository; this folder takes the argv that run would use (`runArgv`) and the stream it writes.

## Files

| File | Purpose |
|------|---------|
| `do-work/session-runs.mjs` | `eventsOfLine(stream, line)`, `lineSplitter(onLine)`, `runArgv(harness, argv, { tools })`, `progressKeeper({ path, app, stream })`, `writeProgress`, `progressPath`, and `workspaceTools` / `setWorkspaceTools` / `clearWorkspaceTools`. |
| `do-work/computer-settings.mjs` | `computerSettings(rules)` and `keepComputerSettings(values, rules)`: this computer's settings file (`folder`/`settings_file`), read whole and kept in one write. |
| `do-work/follow-runs.mjs` | The command line: `--allow-tools <folder> <Tool,Tool>`, `--tools [folder]`, `--clear-tools <folder>`, `--events <harness id> < stream`. |
| `read-data/ai-command-lines.json` | `folder`, `settings_file`, `progress_folder` and one `harnesses` row per command line (`resume`, `allowed_tools`, `stream`). |
| `test/session-runs.test.mjs` | The old tests' cases: both command lines' streams normalise the same, the progress file is bounded and never keeps thinking, the allow-list rides only a command line with the flag; and the command line. |
| `tool-rows.json` | `tool:read-an-ai-command-line-run-as-events`, `tool:allow-my-ai-command-line-tools-in-a-folder` (`on-your-computer`). |
| `part.json` | Nothing here is imported by other code. |
