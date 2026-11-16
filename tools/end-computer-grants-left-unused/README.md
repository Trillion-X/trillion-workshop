# tools/end-computer-grants-left-unused/

Ends the computer capabilities a person granted their tools once they have gone unused for the person's own window, and reminds the person a week before. One row, `tool:end-computer-grants-left-unused`, with a wake the person switches on (`wake:switch`, every six hours).

The engine holds no end and reads none (trillion-rust `src/tool_runs/tools/computer/grants.rs`): a grant is admitted by being present. It keeps two facts beside each grant and answers them in its list, when the grant was accepted (`granted_at`) and when a run last used it (`last_used`); every run that uses a grant moves `last_used`. This tool reads them. A grant whose later time plus `unused_days` (90) has passed is withdrawn through the door's `grants:withdraw`, which only ever ends a grant. A grant inside `remind_days` (7) of that day gets one reminder task in the inbox list, made once and left as the person leaves it, and removed when the grant is used or ended. The owner's decision case `messages-become-seeds:grant-lapse-for-ai-session-folders-2026-11-13` (ninety days unused with a reminder) is the default; a run may be given other numbers.

A condition is a row the person holds and a wake they switched on acts on it (decision case `no-grant-condition-in-engine-code:where-conditions-live-2026-11-16`). The run holds the person's rights narrowed to its row: it may list and withdraw grants and may never make one.

## Files

| File | Purpose |
|------|---------|
| `do-work/end-computer-grants-left-unused.mjs` | `endComputerGrantsLeftUnused(input, { door })`: the one export the row runs; withdraws each grant left unused past its window, makes the reminders and removes the stale ones |
| `read-data/end-computer-grants-left-unused.json` | DATA: the window and the reminder days, the reminder row's kind, prefix and list, and every word the tool says |
| `tool-rows.json` | The row `tool:end-computer-grants-left-unused`, its rights (`computer-grant` for ending and listing, the reminder rows to read and write) and its wake |
| `kits/end-computer-grants-left-unused.json` | The kit that says how to ask for it and what comes back |
| `test/end-computer-grants-left-unused.test.mjs` | A stand-in records door holding exactly the row's rights and answering the engine's computer grants door: an unused grant withdrawn, a used one kept, the reminder made once and removed, a refused withdrawal, and that the row can never make a grant |

## Dependencies

**Depends on:** the engine's computer grants door (`grants:list`, `grants:withdraw`, handed to a run whose row declares `{ "computer-grant": ..., "operations": [...] }`), `tools/records-door` (`computerGrants`, `list`, `write`).

**Depended on by:** nothing; the person switches its wake on.
