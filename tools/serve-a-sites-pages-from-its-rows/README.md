# Serve a site's pages from its rows

`tool:serve-a-sites-pages-from-its-rows` is one kept-running program that serves a whole site from the site's own rows. A page is
a row; what a page shows is the screen of the tool that owns that job, filled with that tool's answer. The same answer opens the
same screen in a person's AI app, so a site and an AI never show different things. Nothing in this folder knows any one site.

## Start it

```
cd tools/serve-a-sites-pages-from-its-rows
CREDENTIALS_DIRECTORY=/path/to/the/units/credentials node do-work/serve.ts /path/to/settings.json
```

On a computer it is a unit its computer row starts (`tool:start-a-computer`), behind the computer's front web server; the unit's
credentials folder is where the computer seals the site's door pass and the files store's read key. It needs Node 26.13 or newer
(TypeScript runs as it is, with no build) and the Workshop's packages (`npm ci` at the Workshop's top folder).

## What it answers

| Address | Answer |
|---|---|
| `/screen-files/<identity>.<kind>` | a page's mount script, its stylesheet, or a font the shared looks name, by BLAKE3 identity, kept for good |
| `<member_files.path><key>` | for a member: 302 to a presigned GET of that key; for anyone else: 403; always `private, no-store` |
| `/sitemap.xml` | every public page address; a template page lists one address per `slug` of its collection |
| a page row's address | the page, drawn on the server; a members page only for a member, sent `private, no-store` |
| anything else | the page row `/404`, or plain words, with status 404 |

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

A layout node is one of:

```
{ "part": "ui/show/pricing/Pricing.tsx", "export": "Pricing", "props": { ... }, "children": [ ...nodes ] }
{ "tool": "tool:read-published-articles", "input": { ... } }    that tool's screen with its answer
{ "main": true }                                                the page's own tool screen
{ "text": "words" }
```

A part is a `show/` file under the tools folder; nothing else can be placed. A tool's screen is its card's
`"screen": {"kind": "module", "entry": "show/<Name>.tsx", "export": "View"}`; its props are exactly the tool's answer.

`site_look`: one row per CSS variable (`name`, `value`), written on every page as `--name: value` after the shared looks, so the
site's rows win. A value holding `; { } < >` or a backslash refuses the set.

## Settings

```json
{
  "listen": "unix:/run/site/site.sock",
  "origin": "https://example.com",
  "lang": "en",
  "door": { "address": "unix:/run/engine/door.sock", "pass_credential": "site-door-pass" },
  "pages": { "database": "a_site_for_who_uses_it", "use": { "purpose": "serve the site", "surface": "site pages" }, "refresh_seconds": 60, "answer_seconds": 60 },
  "sign_in": { "address": "unix:/run/sign-in/sign-in.sock", "page": "/sign-in", "issuer": "https://example.com", "audience": "https://example.com", "team_claim": "team_ids", "members_team": "<team id>" },
  "member_files": { "path": "/member-files/", "endpoint": "https://s3.us-west-004.backblazeb2.com", "region": "us-west-004", "bucket": "<bucket>", "style": "path", "prefixes": ["lessons/"], "link_seconds": 21600, "credential": "member-files-read-key" }
}
```

- `door.pass_credential`: the site's own pass, used for public pages and every row read.
- `pages.answer_seconds`: how long a public page's tool answer is kept (0 keeps none). A members page's answers are never kept.
- `sign_in`: a members page asks the sign-in tool (`tools/better-auth-official`) for the visitor's pass (`/api/auth/token`), checks
  it against that tool's keys (`/api/auth/jwks`): EdDSA, ES256 or RS256, issuer, audience, end, and `team_claim` holding
  `members_team`. That pass is the caller for the page's tool runs, so the door judges the member by their own pass. No pass:
  302 to `sign_in.page?next=<address>`.
- `member_files.link_seconds`: at least the longest video, at most 604800; the player asks for a new link on a 403.

## Files

| File | What |
|---|---|
| `tool-rows.json` | the card: a program on your computer, `node do-work/serve.ts {settings}` |
| `do-work/serve.ts` | settings, the request order above, kept rows and answers, listening on the socket or port |
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
