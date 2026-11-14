# Put back what runs

Everything that runs is rendered by its owner from DATA rows and is never changed by hand, even when urgent. This folder is the one generic reconciler that keeps it so. It names no owner, no thing, no kind of file and no place: owners declare themselves as DATA.

## The declarations file

```json
{
  "kind": "what-runs-owners",
  "owners": [
    {
      "owner": "owner:start-a-computer",
      "module": "../start-a-computer/do-work/start-a-computer.mjs",
      "differences": "hostLayoutDifferences",
      "put_back": "applyHostLayout",
      "interval_seconds": 300,
      "things": [{ "thing": "computer:<its name>", "args": [{ "address": "<address>", "ssh": { "known_hosts": "/abs/known_hosts" } }, { "$file": "<its layout row>.json" }] }]
    }
  ]
}
```

- `module` is the owner's module (relative to the declarations file); `differences` is the export that answers an array of differences between what runs and what the owner's rows render (empty when they match); `put_back` is the export that renders the rows again. Without `put_back` the owner is reported only.
- `things` are the owner's things; `args` are passed, as JSON, to both exports. An argument `{ "$file": PATH }` is that JSON file, so each thing's row stays its own row (a computer's layout row, for example). Hosts are DATA: the declarations and the rows live in the person's own data, never in this folder.
- `interval_seconds` is how often `watch` asks that owner again.

## What it answers

`node tools/put-back-what-runs/do-work/put-back-what-runs.mjs once DECLARATIONS_FILE [--findings FILE] [--report-only]` asks every owner, has it put each difference back, asks again, and prints `{ checked_at, owners, findings }`. Each finding row is `{ kind: "what-runs-finding", id, owner, thing, difference, found_at, put_back }`, where `put_back` is `put back`, `still different after put back`, `appeared after put back`, `put back failed`, `not read` (the owner could not read what runs: an error, never taken for "no difference") or `reported only: ...`. `--findings FILE` appends each row to FILE as one JSON line. Exit status 3 means some thing is still different or could not be read.

`watch` runs the same pass forever, asking each owner when its own interval has passed. To run it from systemd instead, a timer (`OnUnitActiveSec=`) that starts `once` is the documented way: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html.

## The first owner

`tools/start-a-computer` declares `hostLayoutDifferences` (every file a computer's layout row renders, every unit drop-in the row does not declare, every unmanaged item that went missing) and `applyHostLayout` (writes only the files that differ, keeping each replaced file beside it as `NAME.bak-STAMP`, moves an undeclared drop-in aside the same way so systemd no longer loads it, validates a Caddy file before it replaces the live one, and restarts and health-checks what changed).

## Checks

`test/put-back-what-runs.test.mjs`: a hand edit to a thing of start-a-computer (a Caddy file edited and a drop-in placed by hand, on a stand-in computer) and of a second, synthetic owner (`test/owner-of-files-in-a-folder.mjs`, files rendered into a folder) is reported and put back, from one declarations file, with no reconciler code naming either; an owner with no `put_back` is reported only; a failed read is a finding, not "no difference"; each owner is due on its own interval; and the reconciler's source names no owner, host, file kind or address.
