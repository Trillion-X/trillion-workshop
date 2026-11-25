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
held. Members pages are then refused (403): they need the member's own pass on the engine door.

With no `listen` in the settings it listens on `127.0.0.1:18440` (a local run); then
`curl -H 'X-Forwarded-Host: example.com' http://127.0.0.1:18440/sitemap.xml` reads it as the front web server would.

On a computer it is a unit its computer row starts (`tool:start-a-computer`), behind the computer's front web server; the unit's
credentials folder is where the computer seals the site's door pass and the files store's read key. It needs Node 26.13 or newer
(TypeScript runs as it is, with no build) and the Workshop's packages (`npm ci` at the Workshop's top folder).

## What it answers

| Address | Answer |
|---|---|
| a path a `pass_on` entry names (a POST an action row names stays the site's) | passed whole to that program (the sign-in tool's pages and `/api/auth`; a program's actions that have no tool yet), its answer passed back whole |
| `/screen-files/<identity>.<kind>` | a page's mount script, its stylesheet, or a font the shared looks name, by BLAKE3 identity, kept for good |
| `<member_files.path><key>` | for a member: 302 to a presigned GET of `key_prefix` + key; for anyone else: 403; always `private, no-store` |
| a path under `public_files.paths` | 302 to a presigned GET of `key_prefix` + the path without its leading slash, `public, max-age=cache_seconds` |
| a POST to an action row's address | that row's tool, its input made from the posted form or JSON, the cookies, the member's pass and the site's rows; a form is sent on (303), JSON gets JSON |
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
| `input` | jsonb: that tool's input; a string `":slug"` takes the path's value |
| `collection` | the table whose `slug` column lists a template page's addresses (the sitemap) |
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

A form or a script on a page posts to an address; the site's action row for it (table `settings.actions`) names the tool that
does the job. A screen part posts a plain form, or JSON, to the address the page row gives it; it holds no callback.

| Column | Holds |
|---|---|
| `path` | the address pattern, as a page's (`/checkout`, `/book/:offer`) |
| `host` | the one host it answers on, or null for every host |
| `access` | `public` (run as the site, or as the member when one is signed in) or `members` (members only) |
| `tool` | the tool that does the job |
| `input` | jsonb: the tool's input; a value `{ "$": "<source>", ... }` is filled from the request |
| `answer` | jsonb: `{ "redirect_from": "<answer key>" }`, `{ "redirect_to": <value> }` or `{ "json": ["<answer key>", ...] }` |
| `failed` | the words a visitor gets when the tool fails |

Sources: `body` (`key`, dotted into JSON), `path` (`name`), `cookie` (`name`, and `when: { cookie, is }` for a consent),
`member` (`claim` of the member's pass), `origin` (`then`), `rows` (`sql`, `params`, `database`: a statement run as the site),
`url` (`base`, `query`), `number` (`of`), `answer` (`key`, in `redirect_to` only), `now`, `new_id`. A source that gives nothing
leaves its key out, so the tool's own schema refuses a missing required value. A form post is answered 303 to the address; a
JSON post gets `{ "redirect": address }` or the listed keys; a failure is 502 with the row's `failed` words. A post whose
`Origin` is another site is refused (403); a body over 64 KB is refused (413).

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

## Settings

```json
{
  "listen": "unix:/run/site/site.sock",
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
- `pass_on`: `[{ "name", "address", "paths", "exact", "hosts" }]`. A request under one of `paths` (a path and what is under it),
  or at one of `exact` (that path only), on one of `hosts` (every host when left out), is passed to `address` whole; the first
  entry that takes it wins. Example: `{ "name": "the sign-in tool", "address": "unix:/run/sign-in/sign-in.sock", "paths": ["/sign-in", "/api/auth"] }`.
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

## Files

| File | What |
|---|---|
| `tool-rows.json` | the card: a program on your computer, `node do-work/serve.ts {settings}` |
| `do-work/serve.ts` | settings, the request order above, kept rows and answers, listening on the socket or port |
| `do-work/actions.ts` | action rows checked, a request's values filled into a tool's input, the address a visitor is sent to |
| `do-work/pages.ts` | page rows checked, path matching, `:name` values, the sitemap's slugs |
| `do-work/render.ts` | a page's tree filled with tool answers, bundled once per set of modules, drawn as a whole document |
| `do-work/render-layout.ts` | the one tree drawer, used by the server bundle and the browser's mount script alike |
| `do-work/page-styles.ts` | the parts' stylesheet: Screen Look's Tailwind for the bundle's classes, the shared looks, the light theme |
| `do-work/screen-files.ts` | built files kept and served by BLAKE3 identity |
| `do-work/member-pass.ts` | who a request is: the sign-in tool's pass, checked |
| `do-work/member-video.ts` | a member's file: the right check and the presigned GET (signature version 4) |
| `do-work/door.ts` | one request to a URL or unix socket; one tool run on the engine's door |
| `show/PageDocument.tsx` | the page's document around the drawn tree, its mount the shared Container |
| `tests/*.test.ts` | `node --test`: rows, drawing, a loopback door and sign-in, the published signature example |

## Check it

```
node --test tools/serve-a-sites-pages-from-its-rows/tests/
```
