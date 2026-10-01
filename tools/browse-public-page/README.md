# browse-public-page

Reads public web pages: the one reader of a page's bytes (its title, words, links and the card it describes itself with), and the container tool that fetches one page safely.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The part's manifest: `do-work/page-facts.mjs` is public, since Trillion's `src/read-link.mjs` imports it. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:read-public-web-page`. |
| `test/browse-public-page.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |
| `do-work/page-facts.mjs` | The one page reader, pure and runnable anywhere: `checkedUrl` (a public http(s) address on its standard port) and `extractPage` (title, text, links, and the page's own card: description, pictures, videos, site, icon, structured data). The Worker's Trillion's `src/read-link.mjs` and the container tool both call it. |
| `do-work/page-conventions.json` | Which head tags and structured-data keys carry which fact (title, description, site, pictures, videos, icon), and how many of each are kept. |
| `do-work/browse_public_page.mjs` | The container tool `tool:read-public-web-page` (`tool-rows.json`): checks each DNS answer, pins it to the socket, refuses private addresses, follows checked redirects, reads at most 2 MB, and answers `extractPage` of the page as JSON on stdout. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `checkedUrl` | `(input: string) => URL` | Throws a plain-words error for anything but a public http(s) page address. |
| `extractPage` | `(body: string, base: URL \| string, plain?: boolean) => { title, text, links, description, image, images, videos, site, icon, data }` | Everything one page's bytes say; a fact the page does not state is null or empty. |
| `fileFacts` | `(address, mediaType) => { images, videos }` | What a link that is itself a picture or video adds. |
| `publicAddress` | `(address: string) => boolean` | Whether an IP address is on the public internet (container tool only). |
| `readPublicPage` | `(url, fetchPage?) => Promise<{ url, final_url, status, ...extractPage }>` | The container tool's read. |

## Dependencies

**Depends on:** nothing but the platform (`page-facts.mjs` uses no Node-only module; `browse_public_page.mjs` uses `node:dns`, `node:http(s)`, `node:net`).

**Depended on by:** Trillion's `src/read-link.mjs` (the link card, `tool:read-a-link`), `tool-rows.json` (`tool:read-public-web-page` ships `browse_public_page.mjs`, `page-facts.mjs` and `page-conventions.json` into the container), `test/share-link-cards.test.mjs` (a shared link's card filled in later), `test/browse-public-page.test.mjs`, `test/read-link.test.mjs`.
