# Serve a site's pages from its rows

`tool:serve-a-sites-pages-from-its-rows` is one kept-running program that serves a whole site from the site's own rows. A page is
a row; what a page shows is the screen of the tool that owns that job, filled with that tool's answer. The same answer opens the
same screen in a person's AI app, so a site and an AI never show different things. Nothing in this folder knows any one site.

## Start it

```
cd tools/serve-a-sites-pages-from-its-rows
CREDENTIALS_DIRECTORY=/path/to/the/units/credentials node do-work/serve.ts /path/to/settings.json
```

A local run with no credentials folder takes its one credential (the files store's read key) on standard input, piped from the
vault's held-value read (`sh read-a-held-value.sh read <store key name> | node do-work/serve.ts /path/to/settings.json`), so the
key is never in a file or an argument.

For a local run on a person's own computer with no door pass, set `"door": {"address": "cli:<command>", "pins": ["<computer pin>"]}`:
each read is run by that computer's own signed-in command (the Workshop's `use-your-tools-from-a-shell` door-op), and no pass is
held. On a computer with no Mac app door (a Linux server) add `"origin": "http://127.0.0.1:<engine port>"` and
`"key_credential": "<name>"`: the command calls that engine with the owner's key, read from the unit's credentials and handed
to it only in its `{CLI}_KEY` environment name (the command's name in capitals, then `_KEY`). Members pages cannot be drawn through a
command (they need the member's own pass on the engine door): pass them on with a `pass_on` entry marked `"first": true`
(such as `/members` to the program that still draws them); with none they are refused (403).

`listen` is one socket or port, or a list (one socket per host name when the front web server routes each name to its
own socket). With no `listen` in the settings it listens on `127.0.0.1:18440` (a local run); then
`curl -H 'X-Forwarded-Host: example.com' http://127.0.0.1:18440/sitemap.xml` reads it as the front web server would.

On a computer it is a unit its computer row starts (`tool:start-a-computer`), behind the computer's front web server; the unit's
credentials folder is where the computer seals the site's door pass and the files store's read key. The unit's template is
`on-a-computer/serve-a-sites-pages.service`: the row gives `tool_folder`, `repository`, `workshop`, `workshop_commit`,
`node_bin`, `user`, `group` (the web server's, so it can reach the sockets), `runtime_directory` (`sites/<name>` for each host
name, whose `http.sock` the front web server's each-name-its-own-folder site sends that name's requests to when no page file
answers), `settings_file` and `settings`, `credentials`, `stop_seconds`, `writable` and `state` (the unit's state folder, which
the computer makes at set-up; the unit starts in it, because systemd enters the working folder before the Workshop copy is
fetched, so a working folder inside the copy could never start on a new computer). A stop (SIGTERM) finishes the calls
already taken, for up to 25 seconds. The fetch and checkout hold a kernel lock (flock on `.git/unit-fetch.lock`) and clear
git's leftover `*.lock` files only while holding it, so a fetch killed part way never blocks the next start. A start that
keeps failing stops after 5 tries in 5 minutes (StartLimitBurst) and stays failed instead of restarting forever. The
program asks the door for nothing but tool runs, so the site's pass needs no right beyond running its tools; its first
reads (the rows through run-sql, the site head) are real runs, and a tool this computer lacks or a pass the door refuses
stops the start there. A door refusal is always quoted (its status, code and words, at most 400 characters), never hidden.
`tests/unit-start.test.ts` starts the rendered unit in the order systemd does (working folder, then each ExecStartPre, then
ExecStart): on an empty Workshop folder, on a copy a killed fetch left with git's lock files (both must answer 200 on both
sockets), and with a door that lacks the site head tool and refuses every method but tools:run (the start must stop with
the door's words). It needs Node 26.13 or newer
(TypeScript runs as it is, with no build) and the Workshop's packages (`npm ci` at the Workshop's top folder).

## What it answers

| Address | Answer |
|---|---|
| a path a `pass_on` entry names (a request an action row names stays the site's, and so does a page row whose path is longer than the entry's and under it, so a site takes another program's addresses over one row at a time; an `exact` path, or one under the `paths` of an entry marked `"first": true`, is always passed on, ahead of the site's own action and page rows) | passed whole to that program (the sign-in tool's pages and `/api/auth`; a program's actions that have no tool yet), its answer passed back whole |
| `/screen-files/<identity>.<kind>` | a page's mount script, its stylesheet, or a font the shared looks name, by BLAKE3 identity, kept for good |
| `<member_files.path><key>` | for a member: 302 to a presigned GET of `key_prefix` + key; for anyone else: 403; always `private, no-store` |
| a path under `public_files.paths` | 302 to a presigned GET of `key_prefix` + the path without its leading slash, `public, max-age=cache_seconds` |
| a POST (or a GET) to an action row's address | that row's tool, its input made from the posted form or JSON, the cookies, the member's pass and the site's rows; a form is sent on (303), JSON gets JSON |
| `/sitemap.xml` | every public page address; a template page lists one address per `slug` of its collection |
| a page row's address | the page, drawn on the server; a members page only for a member, sent `private, no-store` |
| a members address, signed out | `sign_in.signed_out: "redirect"`: 302 to `sign_in.page?next=<address>`; `"draw"`: the page row at `sign_in.page`, drawn at that address, 200 |
| anything else | the page row `/404`, or plain words, with status 404 |

One unit answers every host in `origin` and `hosts`: a request's host is its `X-Forwarded-Host` when the front web server sets
it, else its `Host`; any other host is answered as `origin`'s. Canonical addresses and the sitemap use the request's host. The
page's mount is `#root`.

A tool that fails draws a 502 page of plain words; the door refusing a member draws 403. Each page's tool runs are timed in its
`Server-Timing` header.

## The rows

All in the database `settings.pages.database`, read with `tool:run-sql-in-my-database` under the declared use `settings.pages.use`
(the computer opens the database with its reader login). The rows are read again every `pages.refresh_seconds`; if a read fails
the last good set stays served.

`pages`: one row per page.

| Column | Holds |
|---|---|
| `path` | the address pattern: `/`, `/articles`, `/courses/:slug` (a `:name` part takes one path part; a literal part wins) |
| `title` | the page's title |
| `access` | `public` or `members` |
| `layout` | jsonb: the page's tree of parts, or null when the page is only its tool's screen |
| `tool` | the tool whose screen is the page's main part, or null |
| `input` | jsonb: that tool's input; a string `":slug"` takes the path's value, and a string `":query.token"` the address's query value for `token` (left out when the address has none); so does one in any layout node's `props` or a layout tool node's `input` |
| `collection` | the table whose `slug` column lists a template page's addresses: the sitemap lists them, and any other value of the page's `:name` is 404 (its tool is never asked) |
| `updated_at` | when the row changed (the sitemap's lastmod) |
| `host` | the one host the page answers on, or null for every host; a host's own row wins over a row for every host |

A layout node is one of:

```
{ "part": "ui/show/pricing/Pricing.tsx", "export": "Pricing", "props": { ... }, "children": [ ...nodes ] }
{ "tool": "tool:read-published-articles", "input": { ... } }    that tool's screen with its answer
{ "tool": "tool:read-movement-pairs", "input": { ... }, "part": "<folder>/show/<Other>.tsx", "export": "View" }
                                                                another screen file, drawn with that tool's answer
{ "main": true }                                                the page's own tool screen
{ "text": "words" }
```

A part is a `show/` file under the tools folder; nothing else can be placed. A tool's screen is its card's
`"screen": {"kind": "module", "entry": "show/<Name>.tsx", "export": "View"}`; its props are exactly the tool's answer.

`site_look`: one row per CSS variable (`name`, `value`), written on every page as `--name: value` after the shared looks, so the
site's rows win. Name them by the role tokens the shared parts read (`button-primary-bg`, `accent-primary`, `thread`, `ink`,
`text-primary`, `font-primary`, `radius-card`, ...); a dotted name becomes dashes. A value holding `; { } < >` or a backslash
refuses the set. Two names are not variables:
- `theme`: the Screen Look theme the page starts from (its palette is written first);
- `font-face.<anything>`: `"<family>|<weight>|<normal or italic>|<path or https address of a font file>"`, an `@font-face`
  rule whose file is read once (a public file from the files store) and served from this site by identity, so no
  cross-origin font rule is needed. Example: `font-face.body-400` = `Body Sans|400|normal|/assets/fonts/body-regular.woff2`.

## Actions

A form or a script on a page posts to an address, or a script reads one; the site's action row for it (table
`settings.actions`) names the tool that does the job. A screen part posts a plain form, or JSON, to the address the page row
gives it, or reads it; it holds no callback.

| Column | Holds |
|---|---|
| `path` | the address pattern, as a page's (`/checkout`, `/book/:offer`) |
| `host` | the one host it answers on, or null for every host |
| `method` | `POST` (the column left out, or null, is POST) or `GET` (a read: a checkout's state, the offers a buyer may see; it answers HEAD too) |
| `access` | `public` (run as the site, or as the member when one is signed in) or `members` (members only) |
| `tool` | the tool that does the job |
| `input` | jsonb: the tool's input; a value `{ "$": "<source>", ... }` is filled from the request |
| `answer` | jsonb: `{ "redirect_from": "<answer key>" }`, `{ "redirect_to": <value> }`, `{ "json": ["<answer key>", ...] }` or `{ "reply": { "status": <value>, "headers": { "location" \| "set-cookie" \| "retry-after" \| "cache-control": <value> }, "json": [keys] } }` (the answer as the tool says it: the status its value gives, 100 to 599; each header whose value gives something, a location one a visitor may be sent to, every value printable on one line; those keys as JSON, or no body when `json` is left out: a short link's 302 or 404, a one-click unsubscribe's empty 200), and optionally beside it `"cookie": { "name", "value": <value>, "max_age_days", "http_only" (default true) }`: once the tool has answered, that cookie is set (Path=/, SameSite=Lax, Secure) when its value is words of letters, digits and `._-` the request does not already carry |
| `failed` | the words a visitor gets when the tool fails |
| `says_why` | true: when the row's own tool refuses, the visitor gets the tool's own words for why beside `failed` (JSON `{ error, why }` with 422; a form post's page carries both), for a tool whose refusals name a rule and never a value (a form step). Left out or null: never. A nested tool's words, and any failure other than a refusal, are never passed |
| `then` | jsonb or null: `{ "tool", "input" }`, run once the row's own tool has answered (a journey step kept only for a checkout that started); its input may read `{ "$": "answer" }` and `{ "$": "input" }`. Its failure is logged and never changes what the visitor gets |
| `next` | jsonb or null: `[{ "when": <value>, "tool", "input", "failed": { "tool", "input" } }, ...]`, steps run in order once the row's own tool answered, each only when its `when` gives true (left out: always), their input reading `{ "$": "answer" }` and `{ "$": "input" }`. A step that fails runs its `failed` step (a signup's `send_failed`) and the visitor gets the row's failure; the `failed` step's own failure is only logged |
| `undo` | jsonb or null: `{ "tool", "input" }`, run when the row's own tool was started and failed, to put back what the tools its input ran had done (a calendar event put before a booking could be kept); its input may read `{ "$": "input" }`, what the failed tool was given. The visitor still gets the failure |

Sources: `body` (`key`, dotted into JSON), `path` (`name`), `query` (`key`: the address's query value), `cookie` (`name`, and `when: { cookie, is }` for a consent),
`member` (`claim` of the member's pass), `origin` (`then`), `rows` (`sql`, `params`, `database`, `key`: a statement run as the site, or that place in its rows),
`tool` (`tool`, `input`, `key`: another tool's answer, run first as the action runs; tools that feed each other nest, each run once, and two sources naming one tool with one input are one run),
`url` (`base`, `query`), `number` (`of`), `first` (`of`: values tried in order, the first that gives something), `boolean` (`of`: true, "true", "on", "yes", "1" and their opposites), `when` (`cookie`, `is`, `then`: the value only while that cookie holds that word, a consent), `address` (`of`, `part`: `origin`, `host`, `path` or `query`, the query as an object, or with `key` one query value), `referer` (the address of the page the request came from), `pick` (`of`, `from`: `{ "<word>": <value> }`, `else`: the value `from` holds for the words `of` gives, an outcome's status), `answer` (`key`) and `input` (`key`: the input the tool was given), in the answer only, `now`, `new_id`. A source that gives nothing
leaves its key out, and an object all of whose values gave nothing is left out too (a signed-out buyer sends no
`customer`), so the tool's own schema refuses a missing required value. A page's beacon may send its JSON as `text/plain`. A form post is answered 303 to the address; a
JSON post gets `{ "redirect": address }` or the listed keys; a GET gets the listed keys, or is sent on (303); a failure is 502 with the row's `failed` words. A post whose
`Origin` is neither one of the site's hosts nor the address the post was sent to is refused (403); a body over 64 KB is refused (413).

Example, a checkout button's form:

```json
{ "path": "/checkout", "access": "public", "tool": "tool:start-a-stripe-checkout", "failed": "Checkout could not start. Please try again.",
  "answer": { "redirect_from": "redirectUrl" },
  "input": { "seller_connection": "service_connection:stripe:<account>", "offerId": { "$": "body", "key": "offerId" },
    "priceOptionId": { "$": "body", "key": "priceOptionId" }, "customerSelectedAmountCents": { "$": "number", "of": { "$": "body", "key": "amountCents" } },
    "consent": { "billing": true, "legal": true }, "checkoutAttemptId": { "$": "new_id" }, "checkoutStartedAt": { "$": "now" },
    "offers": { "$": "rows", "database": "a_site_for_who_runs_it", "sql": "SELECT * FROM offers" },
    "customer": { "email": { "$": "member", "claim": "email" } },
    "success_url": { "$": "origin", "then": "/welcome?checkout={CHECKOUT_SESSION_ID}" }, "cancel_url": { "$": "origin", "then": "/#pricing" } } }
```

Example, a page's visit beacon (a visitor id only with consent, set as a cookie once kept):

```json
{ "path": "/observe/visit", "access": "public", "tool": "tool:run-sql-in-my-database", "failed": "The visit was not kept.",
  "answer": { "json": ["row_count"], "cookie": { "name": "v", "value": { "$": "input", "key": "params.0" }, "max_age_days": 395 } },
  "input": { "database": "a_site_for_who_runs_it", "sql": "INSERT INTO statements ... SELECT ... WHERE $2 = $3",
    "params": [{ "$": "when", "cookie": "consent", "is": "granted", "then": { "$": "first", "of": [{ "$": "cookie", "name": "v" }, { "$": "new_id" }] } },
      { "$": "address", "of": { "$": "body", "key": "href" }, "part": "origin" }, { "$": "origin" },
      { "$": "address", "of": { "$": "body", "key": "href" }, "part": "query" }] } }
```

## Settings

```json
{
  "listen": ["unix:/run/sites/example.com/http.sock", "unix:/run/sites/app.example.com/http.sock"],
  "origin": "https://example.com",
  "hosts": ["app.example.com"],
  "lang": "en",
  "door": { "address": "unix:/run/engine/door.sock", "pass_credential": "site-door-pass" },
  "pages": { "database": "a_site_for_who_uses_it", "use": { "purpose": "serve the site", "surface": "site pages" }, "refresh_seconds": 60, "answer_seconds": 60 },
  "sign_in": { "address": "unix:/run/sign-in/sign-in.sock", "page": "/sign-in", "issuer": "https://example.com", "audience": "https://example.com", "team_claim": "team_ids", "members_team": "<team id>", "signed_out": "redirect" },
  "actions": "site_actions",
  "site_head": { "tool": "tool:read-the-site-head", "input": { "database": "a_site_for_who_uses_it", "site": "a-site" } },
  "files_store": { "endpoint": "https://s3.us-east-005.backblazeb2.com", "region": "us-east-005", "bucket": "<bucket>", "style": "path", "credential": "files-store-read-key" },
  "member_files": { "path": "/member-files/", "key_prefix": "site-files/", "prefixes": ["lessons/"], "link_seconds": 21600 },
  "public_files": { "paths": ["/assets/", "/images/", "/favicon.png"], "key_prefix": "site-files/", "link_seconds": 604800, "cache_seconds": 86400 }
}
```

- `door.pass_credential`: the site's own pass, used for public pages and every row read.
- `pages.answer_seconds`: how long a public page's tool answer is kept (0 keeps none). A members page's answers are never kept.
- `pass_on`: `[{ "name", "address", "paths", "exact", "hosts", "first", "site_head" }]`. The program is asked for its answer
  uncompressed and it is passed back byte for byte; with `"site_head": true` its whole HTML pages carry the site head (the
  consent bar on the sign-in tool's pages too). A request under one of `paths` (a path and what is under it),
  or at one of `exact` (that path only), on one of `hosts` (every host when left out), is passed to `address` whole; the first
  entry that takes it wins. An `exact` path, and a path under an entry with `"first": true`, is passed on ahead of the site's
  own action and page rows, so a site can hold rows for addresses another program still answers (each write path listed
  exactly while the site's grant reads only). Example: `{ "name": "the sign-in tool", "address": "unix:/run/sign-in/sign-in.sock", "paths": ["/sign-in", "/api/auth"] }`.
- `served_files`: `[{ "hosts", "paths", "named", "key_prefix", "cache_seconds" }]`. Files this program answers itself with
  200 from the files store: a web app's shell page, its module scripts, WebAssembly engines and fonts, which a browser loads
  only from the page's own origin (a 302 to the store, as `public_files` answers, breaks them: the store sends no CORS
  headers). A path in `paths` (a folder ending in `/`, or one whole path) is the key `key_prefix` + the path; a path in
  `named` is `key_prefix` + the name given (`{ "/": "index.html" }` for a host's home). The type comes from the file's name;
  one `bytes=a-b` range is answered 206. Each object is kept in memory (128 MB in all, the least recently asked dropped
  first) and asked of the store again, with its ETag, after `cache_seconds`. A served file answers before page rows, but
  after `pass_on`. Example: `{ "hosts": ["app.example.com"], "paths": ["/workspace/", "/app.js"], "named": { "/": "index.html" }, "key_prefix": "site-app-files/", "cache_seconds": 300 }`.
- `address_cookies`: `[{ "query", "cookie", "pattern", "upper_case", "max_age_days", "domain", "http_only" }]`. A value the
  visitor's arrival address carries (`?ref=CODE`) is kept as a cookie by any GET, on the site's own pages and on passed-on
  ones, when it is the whole of `pattern` (after `upper_case`) and only cookie-safe characters; `Path=/; SameSite=Lax;
  Secure`, `HttpOnly` unless `http_only` is false, and `Domain=<domain>` when the request's host is that domain or under it.
  An action reads it back with `{ "$": "cookie", "name": "<cookie>" }` (a checkout's referral code). Example:
  `{ "query": "ref", "cookie": "site_ref", "pattern": "[A-Z0-9][A-Z0-9-]{3,31}", "upper_case": true, "max_age_days": 30, "domain": "example.com" }`.
- `pass_on` entries with `"stream": true` are piped both ways as they come: every request header passes unchanged (Host,
  `Authorization`, `Mcp-Session-Id`), the answer streams back (an MCP door's event stream, a GET that stays open), and the
  other program's call ends when the visitor's does. Never with `site_head`. Example, an engine's MCP door on an app host:
  `{ "name": "the engine door", "address": "http://127.0.0.1:7198", "exact": ["/mcp"], "hosts": ["app.example.com"], "stream": true }`.
- `addresses`: `{ "<name>": address }`. A `pass_on` address `"named:<name>"` is the one named here, so a computer's setup
  fills one place in for every entry that goes to the same program.
- `site_head`: `{ "tool", "input" }`, the tool whose answer `{ head, body_start }` every page, members pages too, carries at
  the top of its `<head>` and the start of its `<body>`: the consent default first, the Accept and Decline bar, then the site's
  declared tags (`tool:read-the-site-head {database, site}`, placed by that tool's own `withSiteHead`). It is read with the
  rows; a first read that fails stops the start, a later one keeps the last good markup. Left out, pages carry none.
- `sign_in`: a members page asks the sign-in tool (`tools/better-auth-official`) for the visitor's pass (`/api/auth/token`), checks
  it against that tool's keys (`/api/auth/jwks`): EdDSA, ES256 or RS256, issuer, audience, end, and `team_claim` holding
  `members_team`. That pass is the caller for the page's tool runs, so the door judges the member by their own pass. No pass:
  302 to `sign_in.page?next=<address>`.
- `member_files.link_seconds`: at least the longest video, at most 604800; the player asks for a new link on a 403.
- `public_files`: a page row names a public file by its site path; the file sits in the store at `key_prefix` + that path, so
  moving the site's files into the store changes no row. `cache_seconds` is at most half of `link_seconds`.

## Named writes

`tool:keep-a-site-write` keeps one of the site's named writes (`read-data/site-writes.json`: `site-lead`, `site-visit`, `price-view`,
`welcome-series-stop`) from the values an action row gives: `{ database, use, write, values }`, the statement fixed in the file and
every value a parameter, so a post never sends SQL. Under the site's use the computer opens the database with its writer login
(`<database>-writer-connection`, role recipe `may-write-named-columns-under-a-use` in run-sql-in-my-database: only the columns and
functions these writes need), and the write's one transaction claims the use first. The welcome stop calls the owner's
`stop_welcome_series(token)` (SECURITY DEFINER), so the writer never reads a token. Example, the visit beacon above as a named write:

```json
{ "path": "/observe/visit", "access": "public", "tool": "tool:keep-a-site-write", "failed": "The visit was not kept.",
  "answer": { "json": ["row_count"], "cookie": { "name": "v", "value": { "$": "input", "key": "values.visitor" }, "max_age_days": 395 } },
  "input": { "database": "a_site_for_who_runs_it", "use": { "purpose": "publish", "surface": "site/example.com" }, "write": "site-visit",
    "values": { "key": { "$": "new_id" }, "visitor": { "$": "when", "cookie": "consent", "is": "granted", "then": { "$": "first", "of": [{ "$": "cookie", "name": "v" }, { "$": "new_id" }] } },
      "href": { "$": "body", "key": "href" }, "referrer": { "$": "body", "key": "referrer" },
      "href_origin": { "$": "address", "of": { "$": "body", "key": "href" }, "part": "origin" }, "origin": { "$": "origin" } } } }
```

## Files

| File | What |
|---|---|
| `tests/door.test.ts` | the door's refusals quoted |
| `on-a-computer/serve-a-sites-pages.service` | the unit template a computer row names to run it |
| `tool-rows.json` | the card: a program on your computer, `node do-work/serve.ts {settings}` |
| `do-work/serve.ts` | settings, the request order above, kept rows and answers, listening on each socket or port |
| `do-work/actions.ts` | action rows checked, a request's values filled into a tool's input, the address a visitor is sent to |
| `do-work/pages.ts` | page rows checked, path matching, `:name` values, the sitemap's slugs |
| `do-work/render.ts` | a page's tree filled with tool answers, bundled once per set of modules, drawn as a whole document |
| `do-work/render-layout.ts` | the one tree drawer, used by the server bundle and the browser's mount script alike |
| `do-work/page-styles.ts` | the parts' stylesheet: Screen Look's Tailwind for the bundle's classes, the shared looks, the light theme |
| `do-work/screen-files.ts` | built files kept and served by BLAKE3 identity |
| `do-work/member-pass.ts` | who a request is: the sign-in tool's pass, checked |
| `do-work/member-video.ts` | a member's file: the right check and the presigned GET (signature version 4) |
| `do-work/door.ts` | one request to a URL or unix socket; one tool run on the engine's door |
| `do-work/keep-a-site-write.ts` | `tool:keep-a-site-write`: one named write, its values checked and sent as parameters, in one claimed transaction (run-sql's withSqlWrite) |
| `read-data/site-writes.json` | the named writes: each one fixed statement and the values it takes, in parameter order |
| `kits/keep-a-site-write.json` | start here and a worked example |
| `show/PageDocument.tsx` | the page's document around the drawn tree, its mount the shared Container |
| `tests/*.test.ts` | `node --test`: rows, drawing, a loopback door and sign-in, the published signature example |

## Check it

```
node --test tools/serve-a-sites-pages-from-its-rows/tests/
```
