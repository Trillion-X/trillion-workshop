# tools/check-where-work-is-kept/

Refuses a tool call that would keep an AI's work on disk instead of in the person's Trillion lists, and says, for each refused path, which list keeps it and the exact `records:write { records: [{ id, type, value }] }` call that writes it there. A write passes only into a declared source repository's source (tracked, or new and not ignored), that repository's `.git/scratch`, or a list copy the list-copy sync makes. Where a write may go, which places are refused, which list each refused place points to and which classifier is asked are the caller's rules, never this tool's: the person keeps them in the check row that runs it.

## How a call is read

The paths a call writes: a Write or Edit's `file_path`; in a Bash command each output redirect (`>`, `>>`, `&>`, `2>`, `>|`), and what `tee`, `cp`, `mv`, `install`, `ln`, `mkdir`, `touch`, `dd of=`, `curl -o`/`-O`/`--output-dir`, `wget`, `mktemp`, `tar -x -C` (so `git archive | tar -x`), `tar -c -f`, `unzip -d` and `git archive -o` write. Heredoc bodies and quoted text are not read as commands; a command substitution (`f=$(mktemp)`) is; a `cd` earlier in the same command moves relative paths; `~`, `$HOME`, `$TMPDIR` and `$PWD` are read, and a path naming any other variable is unplaced. A write under `/dev` keeps nothing and is not judged. Code a program runs (`python -c "open(...)"`, a script) is not read: only what the command line itself says it writes.

Each path is placed in this order:

1. In a checkout whose `origin` names one of `source_repositories`, or whose folder a `source_checkouts` row (`{ path, name }`, `~` the home folder) names because it has no origin: its `scratch` (default `.git/scratch`) passes; a tracked file passes; a new file that the repository ignores is unplaced; a new file matching a `new_files_refused` row (and not its `except`) is refused naming its list; any other new file is new source and passes. Elsewhere under `.git` is unplaced.
2. In a `list_copies` folder: refused, naming that list (write the row; the sync makes the file). A Bash command matching `list_copy_sync` is the sync itself and passes whole.
3. In a `refused_places` place: refused, naming its list. A place is a path; `~` is the home folder, `*` one folder, `**` any number; the longest matching place wins, so `~/.ai-orchestra/data` beats `~`.
4. Anywhere else: unplaced. The classifier is asked.

## The classifier

An unplaced path goes to `tools/ask-a-small-model-for-a-verdict` (`do-work/ask-a-small-model.mjs ask`), started as its own program with `timeout_seconds`; this folder holds no provider code. `rules.classifier` is that tool's `ask` request (`rubric`, or `rubrics_file` and `rubric_id`; `providers`; `remember_file`; `passes`, default 1) plus `timeout_seconds` (default 20), `pass_answers`, `lists_by_answer` and `most_paths` (default 5). The content asked about is the path, how it is written, why the rules could not place it, the command and the first lines written. An answer in `pass_answers` (or `true`) passes; an answer that `lists_by_answer` maps, or that is a list id in `lists`, refuses naming that list; `false` refuses naming `default_list`. A model that fails, times out, answers something else, or is not configured passes the path with a warning: a broken model never blocks all work.

## Run by a check row

The person's check list holds a row of type `record:hook-guard` whose `workshop_run` starts this tool for every Write, Edit and Bash call an AI is about to make (`tools/check-every-tool-call` picks and runs it), with the rules inline. `read-data/hook-guard-row.json` is that row, whole: the value to write once this tool is on main.

```json
["node", "{tools}/check-where-work-is-kept/do-work/check-where-work-is-kept.mjs", "--root", "{repository}",
 "--file-path", "{tool_input.file_path}", "--command", "{tool_input.command}", "--rules-json", "..."]
```

Exit 0 passes in silence. Exit 2 refuses, with the plain words on standard error. Exit 1 passes with a warning on standard error (a model that failed, rules that could not be read); the row's `failure_policy` is not `deny`, so `check-every-tool-call` never turns a warning or a crash into a refusal.

A refusal reads:

```
Work an AI keeps goes into the person's Trillion lists, never onto disk.
  /tmp/plan.md (Write): a temporary file, outside every repository.
    Keep it in list:notes instead: records:write {"records":[{"id":"record:note:plan","type":"record:note","value":{"name":"plan","text":"<what you were writing>"}}]}
Everything an AI keeps goes into the person's Trillion lists, never onto disk. A file write passes only for ...
```

The record id is the list's `id_prefix` (default `<type>:`) and the file's name made one plain word; `{name}`, `{file}` and `{path}` in a list's `value` are filled in.

## Files

| File | Purpose |
|------|---------|
| `do-work/check-where-work-is-kept.mjs` | `writtenPaths(call, { cwd, home })`, `placePath(path, rules, { home })`, `keepInstead(path, list, rules)`, `judgeCall({ call, root, rules, home, ask })`, `askTheModel(request, seconds)` and the command line: `--root FOLDER [--file-path PATH] [--command COMMAND] --rules-json RULES` (the hook), or `--root FOLDER --input-on-stdin` with `{ rules, call }` (the Workshop tool, `{ result }` on the last line). |
| `read-data/hook-guard-row.json` | The `record:hook-guard` row that wires this tool: `on` PreToolUse `Write\|Edit\|Bash`, scope `every-repository`, `failure_policy: "warn"`, `timeout_s: 45`, and the rules. |
| `test/check-where-work-is-kept.test.mjs` | Throwaway checkouts and a made-up home: the passing fixtures (tracked source, an Edit, new source, a README, the scratch, `git archive \| tar -x` into it, the list-copy sync, `/dev/null`, a plain command), the refusing fixtures (`/tmp`, home, `.ai-orchestra`, its `data`, a Claude memory file, a new `.md` note, a list copy, `mktemp`), the refusal's words and `records:write` shape, the command reader, the classifier deciding and failing, the real model tool timing out against a server that never answers, and the Workshop tool. |
| `test/run-by-the-check-list.test.mjs` | `read-data/hook-guard-row.json` run by `tools/check-every-tool-call` `check_switches.py run` against a made-up door: a Write to `/tmp` and a Claude memory write refused naming their lists, source writes, an Edit, the scratch and a Read passing. |
| `ports/check-where-work-is-kept.json` | The claim that no older owner did this job. `tools/keep-and-wake-ai-sessions-on-this-computer` `harness/keep-written-files.mjs` copies written files into Trillion after a turn, and `tools/check-declared-places-keep-what-is-written-there` reports declared places that keep nothing; neither refuses a write. |
| `tool-rows.json` | `tool:check-where-work-is-kept`: `{ rules, call }` in, `{ valid, judged, passed, refused, warnings }` out. |

## Dependencies

**Depends on:** Node.js and git; for unplaced paths, `tools/ask-a-small-model-for-a-verdict` and a model the rules name.

**Depended on by:** the person's `record:hook-guard` row, through `tools/check-every-tool-call`.
