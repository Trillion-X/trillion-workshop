# tools/serve-articles-and-signup/

Articles and a double opt-in newsletter signup for one pursuit's site, drawn at request time from that pursuit's own Postgres rows (`articles`, `subscribers`). One module serves any Node site: the site's server hands its article and signup routes to `createSite(...).handle(request)` and everything else to its own program. The module holds no database login and no mail key; the caller passes `db` and `mail`.

## Files

| File | Purpose |
|------|---------|
| `do-work/pursuit-site.mjs` | `createSite({ db, mail, origin, brand, secret, signupText, signupTags, sourceTags, layout, stylesheets, themeAttributes, tokens, author, now, draw })`: `handle(request)` answers `GET`/`HEAD` on `/articles`, `/articles/<slug>`, `/articles/rss.xml`, and `POST /subscribe`, `GET /subscribe/confirm`, `GET|POST /unsubscribe`; it returns null for any other path. Drafts answer only with `previewToken(slug)`. |
| `do-work/subscriber-audience.mjs` | The shared subscriber tag normalization and one-click link signer; `newsletterAudience` filters a page by confirmed state and tag selectors. |
| `do-work/prepare-audience.mjs`, `what-this-tool-does-and-how-to-run-it.json` | `tool:prepare-a-newsletter-audience`: the link key is mounted on descriptor 3 by its vault name; no database is opened and nothing is sent. |
| `test/` | Article rendering and routes; signup tags and consent; suppression races; confirmation; plain and one-click unsubscribe, replays and bad tokens; audience filtering and isolated site keys. |

## How a page is drawn

A site that passes `layout` gets its bare markup inside its layout (see below). Otherwise every page is drawn by the document-page part (`tools/ui/show/document-page`): an article is its `article` (title and markdown), the index and the signup are `blocks` (links and a form), and a page that is not an article carries its heading as its `article` title. document-page writes the body and leaves its head facts empty, and `withSearchHead` (`tools/publish-content-for-discovery/do-work/site-search-head.mjs`) replaces them with the one search head: title, description, canonical, robots, Open Graph, Twitter card and JSON-LD. The index carries its own address as canonical; the other pages that are not articles (signup and confirmation pages, not found) are `noindex, nofollow` with their own address as canonical.

- `stylesheets`: the site's stylesheet addresses (`/...` or https), linked in the page head.
- `themeAttributes`: `data-*` attributes on the `<html>` element, such as `{ 'data-theme': 'paper' }`.
- `tokens`: the site's names for the role tokens document-page reads. `{ 'button-bg': 'button-primary-bg' }` writes `--button-bg` as an alias of the site's `--button-primary-bg`. Names only are written; a colour value never is. A name that is not lower-case words with dashes is refused when the site is made.
- `layout`: still accepted. A site that passes `layout({ title, description, body })` keeps its own page parts: its layout wraps the bare markup of every page the module draws (signup, confirmation, unsubscribe, not found, and the index and articles when there is no `draw`), so its consent bar and parts stay on them. New callers prefer `stylesheets`, `themeAttributes` and `tokens`; those apply to the document-page pages only, so a layout site keeps its styles in its layout. A site that passes `layout` today keeps it unchanged. To move a layout site to document-page's look, it passes `stylesheets`, `themeAttributes` and `tokens`, for example `tokens: { 'button-bg': 'button-primary-bg' }` where its stylesheet names the button background `--button-primary-bg`.
- `draw`: a site's own draw hooks (`index(rows)`, `article(row, { preview })`), which answer the whole page themselves. The module's own drawing is not used then.

## Subscriber tags and sends

The site's own DATA supplies `signupTags` (tags on every signup) and `sourceTags` (path to tag arrays, such as `{ '/guide': ['guide'] }`). Only these declared tags are trusted; tags in a submitted form are ignored. Existing tags are kept, normalized and deduplicated. A confirmed signup may gain tags without another confirmation email; an unsubscribed address must confirm a deliberate re-opt-in. Suppressed, bounced, complained and unknown states cannot be reactivated by the signup route. The subscribers table must have a unique email key; a concurrent insert sends no second confirmation, and every state-changing update compares the state it read.

`tool:prepare-a-newsletter-audience` takes a bounded page of subscriber rows, the site's origin, its held link key's name, and optional `required_tags` / `excluded_tags`. It returns only confirmed matches, each with the same unsubscribe link the site accepts. No database is read and no mail is sent. A newsletter workflow claims each issue/recipient in the pursuit's send table before calling the existing email sender, and uses the link in its footer and one-click headers. A claim is never silently retried after an unknown dispatch outcome. Signup, confirmation and unsubscribe retain their first valid transition; a concurrent suppression cannot be lowered.

## Vendoring

A site that vendors this module copies the same relative paths the Workshop has, so the imports resolve: `do-work/pursuit-site.mjs` and `do-work/subscriber-audience.mjs` with `../../publish-content-for-discovery/do-work/site-search-head.mjs`, `../../ui/show/document-page/`, and the document-page closure: `ui/show/server-rendered-page/escape-html.mjs`, `ui/show/share-row/` (`share-row-html.mjs`, `share-row.json`), `ui/show/site-nav/site-nav-look.mjs`, `ui/show/layer-diagram/` (`layer-diagram.mjs`, `graph-contract.mjs`, `graph-contract.json`), `ui/show/safe-error-card/sanitize-error-text.ts`, and `live-namespace/do-work/blake3.mjs`. The site also installs `@noble/hashes` (a dependency of blake3 and the graph contract). The `.ts` file needs a Node that strips types, or a bundler.

## As a site's act

A site's action rows run `tool:keep-a-newsletter-signup` as the site's share, never as its owner: they give `database` and `use`
(the site's declared use), so the computer opens the database with its writer login under that use, and the run's one transaction
claims it first. That login holds only the column rights `read-data/writer-rights.json` names, which the database's owner gives it
with the role recipe `may-write-named-columns-under-a-use`. The link key (`secret`, its vault name) is opened for a share only when
the site's grant lists that very name (its mount is marked `share_by_listing`). Links already sent keep working: the confirm and
unsubscribe digests are the same keyed digests the module's routes make.

## Known gaps

- Real database and mail round-trips are not proven by this folder's tests; they are proven on the site (see the lane record).
- A row with no description is described by its body's first sentence (headings left out), cut at about 155 characters on a word boundary; its title only when the body is empty.
- Article bodies render as markdown (headings, emphasis, lists, links) through document-page. A layout site's article bodies keep the bare markup they had (paragraphs, headings, same-site or https links).
- Confirmation and unsubscribe tokens use HMAC-SHA256 (node:crypto) rather than BLAKE3, because this module must run without installed packages. Not a content identity.
- The Cloudflare Worker site's own articles and mail handlers (worker/articles.js, worker/mail.js) still run on their Worker; moving them onto this module is a finding for that site's owner.
