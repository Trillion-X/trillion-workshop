# browse-public-page

Reads public web pages: the one reader of a page's bytes (its title, words, links and the card it describes itself with), the container tool that reads one page, and the container tool that reads one link into a card.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The part's manifest: `do-work/page-facts.mjs` is public, since the old app's `src/read-link.mjs` imports it. |
| `tool-rows.json` | The Workshop rows for this folder: `tool:read-public-web-page` and `tool:read-a-link`, both internet:true container rows. |
| `test/browse-public-page.test.mjs` | The page reader and the page tool: address checks, extraction, redirects and the size bound. |
| `test/read-a-link.test.mjs` | The link card: every picture, video and piece of structured data a page declares, a link that is itself a picture or video, the byte cap and the deadline, and the container tool's refusals. |
| `do-work/page-facts.mjs` | The one page reader, pure and runnable anywhere: `checkedUrl` (an http(s) address on its standard port with no user name or password) and `extractPage` (title, text, links, and the page's own card: description, pictures, videos, site, icon, structured data). |
| `do-work/page-conventions.json` | Which head tags and structured-data keys carry which fact (title, description, site, pictures, videos, icon), and how many of each are kept. |
| `do-work/browse_public_page.mjs` | The container tool `tool:read-public-web-page`: follows up to 5 redirects (never from https down to http), reads at most 2 MB, and answers `extractPage` of the page as JSON on stdout. |
| `do-work/read_a_link.mjs` | The container tool `tool:read-a-link`: `readLinkCard`, at most 2 MB and 6 seconds, the bare address with `unread` saying why when the link has no card. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `checkedUrl` | `(input: string) => URL` | Throws a plain-words error for anything but an http(s) page address on its standard port. |
| `extractPage` | `(body: string, base: URL \| string, plain?: boolean) => { title, text, links, description, image, images, videos, site, icon, data }` | Everything one page's bytes say; a fact the page does not state is null or empty. |
| `fileFacts` | `(address, mediaType) => { images, videos }` | What a link that is itself a picture or video adds. |
| `readPublicPage` | `(url, fetchPage?) => Promise<{ url, final_url, status, ...extractPage }>` | The page tool's read. |
| `readLinkCard` | `(url, { fetchPage?, waitMs? }) => Promise<{ url, final_url, host, site, title, description, image, images, videos, icon, data, text, unread }>` | The link tool's read; throws `ReadLinkError` only for an address that is not a web page address. |

## Dependencies

**Depends on:** nothing but the platform (`page-facts.mjs` uses no Node-only module; the two tools use Node's own `fetch`).

**Depended on by:** `tool-rows.json` (each row ships its tool, `page-facts.mjs` and `page-conventions.json` into the container), the old app's `src/read-link.mjs` (its link card), `test/browse-public-page.test.mjs`, `test/read-a-link.test.mjs`.

## Invariants

- No address rule lives here beyond the shape of a web address. Both tools run as internet:true rows, so Node's fetch reaches only the engine's public-only proxy, which judges every address, every redirect and every address a name resolves to; a refused hop reads as a page that did not answer.
- Bounded: at most 2 MB of a page, 30,000 characters of text and 100 links; the link card waits at most 6 seconds.
