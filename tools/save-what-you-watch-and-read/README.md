# tools/save-what-you-watch-and-read/

Reads what a person saved or observed elsewhere so their AI can put it in their lists. This package provides X bookmark and like reads through X's API or a signed-in browser, decoding of exported X bookmarks and Pinterest pins and boards, observations of things watched or read, and observations of files matching a pattern. X API reads return posts newest first, with their full words, authors, links, pictures, and quoted posts. Pinterest API pulls use the generic connected-accounts engine in `tools/pull-from-connected-accounts/do-work/pull.mjs`; this package's Pinterest reader handles export files. These are current source capabilities; this description does not imply that every legacy caller has moved. The tools here read and observe; they do not post, like, follow, or change anything on X.

The X post reader has two ways in, one shape out:

- **`api`**: X's API with the access token the person's X connection holds. The API read asks for entities, notes, referenced tweets and media, so links and quoted posts come from it too.
- **`browser`**: the person's own signed-in X session in a browser profile folder, for a person whose API plan does not allow bookmarks or likes, or whose token has expired.

The tool only reads. Turning the posts into list rows is the job of `tools/export-records-as-list-rows/` with a mapping the person writes (the mapping and the list definitions are the person's own, kept with their library): the posts file below is that tool's staged input.

## Run

```
node do-work/read-saved-x-posts.mjs < request.json
```

Request (JSON on standard input):

| Key | Holds |
|---|---|
| `via` | `api` (the default) or `browser`. |
| `which` | `bookmarks` or `likes`. |
| `already_kept` | Post keys the person already has. The read stops once several pages hold only those. Without it the read goes on until X has no more pages (X hands out the newest 800 bookmarks). |
| `out_file` | Where to write the posts. Without it they are in the answer. |
| `token_fd` | `api` only. The descriptor the access token is mounted on (a held value; the engine mounts it, the tool never sees where it is kept). |
| `profile_dir` | `browser` only. The browser profile folder the person signed in to X with. It must not be open in another browser. |
| `handle` | `browser` only. The person's X name; needed for `likes`. |
| `browser.executable` | `browser` only. A Chromium-family browser. Without it: `CHROME_PATH`, `CHROMIUM_PATH`, the usual places, then the Playwright browser cache. |
| `sign_in: true` | With `profile_dir` only: opens a visible window on X's sign-in page with that profile and waits until the person closes it. Run it once when a read says X asked the profile to sign in. |

Answer: `{ which, via, pages, read, not_kept_yet, posts }` (or `out_file` instead of `posts`; the file also holds `generated`, the time of the read). A post is `{ id, saved_from, saved_as, key, url, title, author, author_name, posted_at, media?, links?, quoted? }`; `id` is `x-<bookmark|like>-<key>`, so one post saved two ways is two items. `title` holds the full words.

Every refusal ends the run with the reason and never gives an empty list: no token handed to the run (no network call is made), X's 401 (expired or revoked token), 403 (the plan or the permission does not allow it), 429 (limited; the reset time is named), a profile that is not signed in, a page X does not answer, a browser that does not start. The token appears in no answer or error.

## Files

| File | Purpose |
|------|---------|
| `do-work/read-saved-x-posts.mjs` | The command above: picks the way, collects, names each post. |
| `do-work/api-source.mjs` | The `api` way: `users/me`, then the list page by page with the next token; the token comes in on `token_fd`. |
| `do-work/browser-source.mjs` | The `browser` way: starts the browser on the profile, scrolls X's list page, keeps the answers X's own page asks for; `signIn`. |
| `do-work/saved-source.mjs` | What both share: the conventions, the kind of list, the saved identity of a post, the collector and its stop rule. |
| `do-work/x-posts.mjs` | Pure: X's page answers (`postsIn`) and API pages (`apiPostsIn`) to the one post shape. |
| `do-work/saved-posts-conventions.json` | DATA: the API address, fields and page limits; which page lists each kind in the browser and which request carries the list; the scroll and stop rules; where a browser is found. Nothing names a person. |
| `part.json` | `x-posts.mjs` is public. |
| `test/saved-x-posts.test.mjs` | Browser answers to posts, links, quoted posts, the stop rule, the request check; all made-up accounts. |
| `test/saved-x-api.test.mjs` | API pages to posts, paging, the stop rule, no token means no network call, each refusal; a stand-in for the network. |
| `test/fixtures/pull-bookmarks.json` | The shape of a posts file, made up: the example to write a mapping against. |

## Dependencies

**Depends on:** Node 22.6 or later (its own `fetch` and WebSocket) and, for `browser`, a Chromium-family browser on the computer. No package.

**Depended on by:** a person's mapping for `tools/export-records-as-list-rows/`; the `x-bookmark-quote-posts` skill reads bookmarks through this tool. Engine row: `tool:read-my-saved-x-posts` (the API way; it mounts the `access_token` of the X connection on descriptor 3). The browser way has no row yet: needs a `computer` capability for a browser on the person's own profile folder; until then it is run from a terminal.

## Reading an exported file and watching files (Python)
Following what a person watches, reads and saves elsewhere, as observations that can be kept and found. Three small
tools: reading an export of saved items (X bookmarks, Pinterest pins and boards), turning one thing seen into one
observation with a stable identity, and finding the files under a folder that are new or changed since the last look.
None of them reaches the internet, keeps anything or reads what a file means; what they give back is handed to
whatever keeps the person's records. Pulling saved items from a site with a token is a different job (a connector);
the export file is the seam it calls.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:read-my-saved-bookmarks-and-pins` | Reads an export of saved items from a folder the person chose: each saved item is one thread of one atom with its words, author and time | on the person's computer, read-a-folder |
| `tool:observe-something-i-watched-or-read` | One thing seen (a page, words, an app window, a feed item) as one observation: id, revision and where it came from | in a container |
| `tool:find-new-or-changed-files` | The files under a chosen folder, matched by a pattern, that are new or changed since the answer before | on the person's computer, read-a-folder |

## Files

| File | Purpose |
|------|---------|
| `read-data/sources.json` | One row for each kind of saved-items export (`x-bookmarks`, `pinterest-saved`); read by the reader in `tools/conversations`. A new site is a new row. |
| `read-data/observe_activity.py` | `observe`: one thing seen becomes one observation; its id is the BLAKE3 identity of source, item and revision. |
| `read-data/observe_files.py` | `observe`: the entries under a granted folder matched by a glob, by state (`<mtime_ns>:<size>`), newest first, never following a link out of the folder. |
| `what-this-tool-does-and-how-to-run-it.json` | The three rows. |
| `test/python/` | The Python tests, with made-up exports and folders; `test/python.test.mjs` runs each as a node test. |
| `test/rows.test.mjs` | Each row's command run the way the engine runs it. |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| Observation | `{ id, source_ref, native_ref, observed_at, content_revision, payload }` | One thing seen. `content_revision` is `1f:` + the BLAKE3 hex of the payload without its time. |
| File observation | `{ source_ref, native_ref, observed_at, state, content_hash, payload }` | One file or folder entry; `native_ref` is its path inside the granted folder. |
| `since` / `next_since` | `{ files: { <path>: "<mtime_ns>:<size>" } }` | What the last answer saw; an unchanged entry is not observed again. |

## Dependencies

**Depends on:** `tools/conversations` (its reader decodes the saved-items export, and its `content_identity.py` gives
the BLAKE3 identity). Every row packs both folders, so the commands run with the two folders beside each other.

The live way in to a person's X bookmarks and likes is `tool:read-my-saved-x-posts` above; the `x-bookmarks` row here only decodes an export file the person already has.

## Carried, not wired

`do-work/process-scripts/acquire-activity-source.py` is the original Bitfield acquisition leaf (plan entry in, observed-content batch out, with cursor, no_action, authorization and provenance), moved byte for byte from bitfield-packages (receipt `moved-from.json`). No tool row runs it: it identifies content with SHA-256 where this repository's rule is BLAKE3, and `read-data/observe_activity.py` (a different, shorter shape) is what the rows run. A lead decides which stays before the wiring is changed.
