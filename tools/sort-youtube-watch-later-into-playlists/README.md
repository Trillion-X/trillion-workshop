# sort-youtube-watch-later-into-playlists

Sorts a person's YouTube Watch Later into public playlists on the same channel. It reads each signed-in channel's Watch Later, subscriptions and playlists, plans which playlist each video goes in from the person's sort settings, shows the plan, then makes the playlists by only adding videos. Watch Later is never changed and no video is ever removed.

The sort settings are the person's own data, kept in their account and passed in at run time: which channels to read, how to find each one's account, and how each is sorted (by scored channel and title rules, or by hand-made lists). They are one row of the person's `list:settings`, `record:setting:sort-youtube-watch-later-into-playlists~<scope_kind>~<scope_id>` (scope_kind `person` when they cover several of the person's channels), whose `settings` field holds the JSON below. A request gives that row as `settings_record`, exactly as the door's `records:read` answers it (or the path of a JSON file holding it), and the shared reader in `tools/settings` checks it; a sample run or a test may give `settings` inline instead. Nothing about any person is in this folder.

## Files

| File | Purpose |
|------|---------|
| `ports/*.json` | The port contracts: each file of `do-work/` and `read-data/` is launch-video `tools/yt-library`'s code, first committed byte for byte, then adapted. |
| `tool-rows.json` | Three rows: `tool:plan-sorting-youtube-watch-later-into-playlists` (`computer`, proved by a sample run), `tool:read-my-youtube-watch-later-and-playlists` and `tool:make-youtube-playlists-from-a-sort-plan` (`on-your-computer`). |
| `part.json` | Nothing here is imported by other code. |
| `do-work/youtube_client.py` | The YouTube web API client (ported from launch-video `ytc.py`): the cookies a browser sends to youtube.com, the signed-in check, the account a channel's `sign_in_as` names, and the reader of a playlist's videos page by page. Shared by the commands below. |
| `do-work/list_signed_in_accounts.py` | Which accounts the browser login holds, by account number, and whether it is signed in (`account_at`, also used to find `sign_in_as`). |
| `do-work/read_channel.py` | Writes `<out_dir>/<slug>/watch-later.json`, `subscriptions.json` and `playlists.json` for each channel (its own readers of subscriptions and the playlist list). Reads only. |
| `do-work/plan_sort.py` | The plan command: reads the sort settings (`settings_record` through `tools/settings`, or inline `settings`) and each sorted channel's Watch Later, answers with the plan, and with `out_dir` writes `sort-plan.json` and `SORT-PLAN.md`. |
| `read-data/sort_plan.py` | The planner itself, pure: rule scoring, hold back, hand-made lists, ordering and the plan page. |
| `do-work/apply_sort.py` | Creates the plan's public playlists and adds their videos; keeps what was made in `applied_file`; safe to run again. |
| `do-work/verify_sort.py` | Checks each playlist's count and that anyone can see it, and that Watch Later is unchanged; writes `verification.json` and `INDEX.md` into `accounts_dir`, and a table of every Watch Later video with its playlists. |
| `test/test_sort.py` | The planner, the commands' refusals, the cookies rule, paging and account lookup, and apply and verify against recorded YouTube replies. |
| `test/sort-youtube-watch-later.test.mjs` | Checks the rows name scripts that exist and runs the Python tests under `npm test`. |

## How to run it

Each command reads one JSON request on standard input and prints `{"result": ...}` or `{"error": "what to change"}` as its last line.

1. Export the browser's YouTube login with `tool:export-browser-login-cookies-for-yt-dlp`, then check it:
   `echo '{"cookies": "cookies.txt"}' | python3 -I tools/sort-youtube-watch-later-into-playlists/do-work/list_signed_in_accounts.py`
   When `signed_in` is false, export again; a browser can take a little while to refresh its login, so wait about 20 seconds and try a few times.
2. Read the channels: `{"cookies", "settings_record", "out_dir"}` into `do-work/read_channel.py` (or name `channels` to read only those).
3. Plan: `{"settings_record", "accounts_dir": out_dir, "out_dir"}` into `do-work/plan_sort.py`, and show the person `SORT-PLAN.md`.
4. With the person's yes, make the playlists: `{"cookies", "plan_file", "applied_file"}` into `do-work/apply_sort.py` (try `limit_playlists: 1` first).
5. Check: `{"cookies", "plan_file", "applied_file", "accounts_dir"}` into `do-work/verify_sort.py`.

### Sort settings

```json
{"channels": [
  {"slug": "kitchen", "label": "Kitchen Channel", "email": "shown in the plan", "sign_in_as": "@kitchen-handle",
   "sort": "rules", "rules": {"max_per_video": 3, "hold_back": "(Secret Recipe)", "hold_back_reason": "kept off public playlists",
     "rules": [{"key": "bread", "title": "Bread Baking", "description": "Loaves.", "channels": "^(Crumb Club|Loaf.*)", "strong": "(sourdough|baguette)", "weak": "(flour)"}]}},
  {"slug": "brand", "label": "Brand Channel", "sign_in_as": "@kitchen-handle", "page_id": "the brand channel's page id",
   "sort": "hand-made", "playlists": [{"key": "best", "title": "Best Of", "description": "Picked by hand.", "videos": [["videoId", "why it is here"]]}]},
  {"slug": "read-only", "label": "Read Only", "authuser": 2}
]}
```

- `sign_in_as` is the account's email or channel handle; the account is found by it each run. Without it, `authuser` (the browser's account number, default 0) is used as given.
- `page_id` acts as a brand channel of that account.
- Rules scoring: a channel name the `channels` expression matches whole scores 3, a `strong` title match 3, a `weak` one 1 (expressions are case-sensitive and start at a word boundary). A video goes to every playlist scoring 3 or more, at most `max_per_video`, highest first, a tie to the earlier rule; with none, to its best weak match, marked low confidence. 6 or more is high confidence.
- A channel without `sort` is only read.

## Dependencies

**Depends on:** Python 3.10+ standard library; `tools/settings/read-data/read_setting.py` (the shared reader of a `list:settings` row); a cookies file from `tool:export-browser-login-cookies-for-yt-dlp`; the internet (www.youtube.com) for every command except the plan.

**Depended on by:** nothing in this repository.

## Tests

```
node --test tools/sort-youtube-watch-later-into-playlists/test/*.test.mjs
WORKSHOP_UNIT_FOLDER=tools/sort-youtube-watch-later-into-playlists node --test test/every-process-row-selector.test.mjs
```

Ported from launch-video `tools/yt-library` (ytc.py, accounts_map.py, read_accounts.py, plan_sort.py, apply_sort.py, verify_sort.py); its relogin.sh loop (export the login again until YouTube answers signed in) is the read row's instruction, and its rules files are the person's settings row.
