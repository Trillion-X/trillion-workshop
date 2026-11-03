# tools/open-a-prompt-in-a-local-ai-app/

Opens one prompt in a local AI app the person already has (Claude Code, Codex, any app with a row), through a launcher the DATA allowlists. It runs on the person's own computer as a `computer` row. Nothing goes through a shell: a url row opens its URL with the prompt and folder percent-encoded, with the operating system's opener as one argument; an argv row runs its list as it is, `{prompt}` and `{folder}` standing for one whole argument. The prompt is never echoed or kept, only its length.

## Files

| File | Purpose |
|------|---------|
| `read-data/open-in-ai.mjs` | `openInAi(input, { spawnImpl?, home?, rules? })`: the tool, answering `launched`, `app_missing` or `refused`; `launchOf(row, { prompt, folder })`: the command a launch runs. The header states the invariants. |
| `read-data/open-in-ai.json` | The apps (one row each; the rows are the allowlist), the opener, the longest prompt, and every word said. A new app is one more row. |
| `tool-rows.json` | `tool:open-in-ai`: a `computer` row with the `open-a-local-app` capability, run by `tools/records-door`'s `run-an-export.mjs`. |
| `test/open-in-ai.test.mjs` | A url launch is one percent-encoded argument to the opener; an unknown, missing or badly asked app is typed and nothing runs; an argv row runs in the folder named; `dry_run` runs nothing; the row runs `openInAi`. |
| `part.json` | Nothing here is imported by other code. |

## Input and answer

| Input | Answer |
|-------|--------|
| `{ app, prompt, folder?, dry_run? }` | `{ outcome: launched \| app_missing \| refused, app, via, command, prompt_chars, folder?, argv? (dry_run, prompt shown as <prompt>), said }` |

## Moved from

Trillion-X/trillion `computer/open-in-ai.mjs`, `computer/open-in-ai.json` and `test/open-in-ai.test.mjs`, carried whole from the last commit that held them (dc79bb0a^; dc79bb0a deleted them because no Workshop row named the tool). Its tests are carried one to one; the one that checked the old Mac host's tool table (`computer/mac-tools.mjs`) is now a check of this folder's row.

## Not yet

- The engine has to know the `open-a-local-app` capability before a `computer` run may start an app. The app rows' `installed` places are the macOS app folders.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, and the operating system's opener (`/usr/bin/open`).

**Depended on by:** `tool-rows.json` only.
