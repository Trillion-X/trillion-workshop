# tools/serve-articles-and-signup/

Articles and a double opt-in newsletter signup for one pursuit's site, drawn at request time from that pursuit's own Postgres rows (`articles`, `subscribers`). One module serves any Node site: the site's server hands its article and signup routes to `createSite(...).handle(request)` and everything else to its own program. The module holds no database login and no mail key; the caller passes `db` and `mail`.

## Files

| File | Purpose |
|------|---------|
| `do-work/pursuit-site.mjs` | `createSite({ db, mail, origin, brand, secret, signupText, stylesheets, themeAttributes, tokens, author, now, draw })`: `handle(request)` answers `GET`/`HEAD` on `/articles`, `/articles/<slug>`, `/articles/rss.xml`, and `POST /subscribe`, `GET /subscribe/confirm`, `GET|POST /unsubscribe`; it returns null for any other path. Drafts answer only with `previewToken(slug)`. |
| `test/pursuit-site.test.mjs` | Markdown escaping, route dispatch, 404 and draft preview, search head, token names, stylesheets, the signup form, HEAD. |

## How a page is drawn

Every page is drawn by the document-page part (`tools/ui/show/document-page`): an article is its `article` (title and markdown), the index and the signup are `blocks` (links and a form), and a page that is not an article carries its heading as its `article` title. document-page writes the body and leaves its head facts empty, and `withSearchHead` (`tools/publish-content-for-discovery/do-work/site-search-head.mjs`) replaces them with the one search head: title, description, canonical, robots, Open Graph, Twitter card and JSON-LD. The index carries its own address as canonical; the other pages that are not articles (signup and confirmation pages, not found) are `noindex, nofollow` with their own address as canonical.

- `stylesheets`: the site's stylesheet addresses (`/...` or https), linked in the page head.
- `themeAttributes`: `data-*` attributes on the `<html>` element, such as `{ 'data-theme': 'paper' }`.
- `tokens`: the site's names for the role tokens document-page reads. `{ 'button-bg': 'button-primary-bg' }` writes `--button-bg` as an alias of the site's `--button-primary-bg`. Names only are written; a colour value never is. A name that is not lower-case words with dashes is refused when the site is made.
- `draw`: a site's own draw hooks (`index(rows)`, `article(row, { preview })`), which answer the whole page themselves. The module's own drawing is not used then.

## Vendoring

A site that vendors this module copies the same relative paths the Workshop has, so the imports resolve: `do-work/pursuit-site.mjs` with `../../publish-content-for-discovery/do-work/site-search-head.mjs`, `../../ui/show/document-page/`, and the document-page closure: `ui/show/server-rendered-page/escape-html.mjs`, `ui/show/share-row/` (`share-row-html.mjs`, `share-row.json`), `ui/show/site-nav/site-nav-look.mjs`, `ui/show/layer-diagram/` (`layer-diagram.mjs`, `graph-contract.mjs`, `graph-contract.json`), `ui/show/safe-error-card/sanitize-error-text.ts`, and `live-namespace/do-work/blake3.mjs`. The site also installs `@noble/hashes` (a dependency of blake3 and the graph contract). The `.ts` file needs a Node that strips types, or a bundler.

## Known gaps

- Real database and mail round-trips are not proven by this folder's tests; they are proven on the site (see the lane record).
- A row with no description is described by its title, since a search head needs words.
- Article bodies now render as markdown (headings, emphasis, lists, links) through document-page; before, only paragraphs and headings were drawn.
- Confirmation and unsubscribe tokens use HMAC-SHA256 (node:crypto) rather than BLAKE3, because this module must run without installed packages. Not a content identity.
- The Cloudflare Worker site's own articles and mail handlers (worker/articles.js, worker/mail.js) still run on their Worker; moving them onto this module is a finding for that site's owner.
