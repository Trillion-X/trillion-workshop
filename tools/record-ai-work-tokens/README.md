# Record AI tokens

`tool:record-ai-work-tokens` reads Claude Code transcripts and returns the usage rows for each assistant message, plus the SQL that stores them in `claude_messages` and moves `transcript_cursors` forward.

Run it: `node tools/record-ai-work-tokens/do-work/record-tokens.mjs REQUEST.json`

- `do-work/record-tokens.mjs`: the program. Node standard library only.
- `data/table.json`: table names, the key, the column order, and the statement timeout.
- `kits/record-ai-work-tokens.json`: the kit.
- `test/record-tokens.test.mjs`: tests on made-up transcript lines.
