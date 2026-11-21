# tools/serve-articles-and-signup/

Articles and a double opt-in newsletter signup for one pursuit's site, drawn at request time from that pursuit's own Postgres rows (`articles`, `subscribers`). One module serves any Node site: the site's server hands its article and signup routes to `handleSiteRequest`-style `createSite(...).handle(request)` and everything else to its own program. The module holds no database login and no mail key; the caller passes `db` and `mail`.

## Files

| File | Purpose |
|------|---------|
| `do-work/pursuit-site.mjs` | `createSite({ db, mail, origin, brand, secret, layout, signupText })`: `handle(request)` answers `/articles`, `/articles/<slug>`, `/articles/rss.xml`, `POST /subscribe`, `/subscribe/confirm`, `/unsubscribe`, or returns null. Drafts answer only with `previewToken(slug)`. |
| `test/pursuit-site.test.mjs` | Escaping, route dispatch, 404 and draft preview. |

## Known gaps

- Real database and mail round-trips are not proven by this folder's tests; they are proven on the site (see the lane record).
- The page look comes from the caller's `layout`; the Screen Look components are not used here yet.
- Confirmation and unsubscribe tokens use HMAC-SHA256 (node:crypto) rather than BLAKE3, because this module must run without installed packages. Not a content identity.
- The Cloudflare Worker site's own articles and mail handlers (worker/articles.js, worker/mail.js) still run on their Worker; moving them onto this module is a finding for that site's owner.
