# browse-public-page

Reads public web pages: the one reader of a page's bytes (its title, words, links and the card it describes itself with), the container tool that reads one page (and, asked to, walks an outlet's archive: from a start address it follows the older listing pages or a sitemap, dates the entries, chooses a window or eras of them and reads those pages politely), and the container tool that reads one link into a card.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The part's manifest: `do-work/page-facts.mjs` is public, since the old app's `src/read-link.mjs` imports it. |
| `tool-rows.json` | The Workshop rows for this folder: `tool:read-public-web-page` and `tool:read-a-link`, both internet:true container rows. |
| `test/browse-public-page.test.mjs` | The page reader and the page tool: address checks, extraction, redirects and the size bound. |
| `test/archive-walk.test.mjs` | The walk on a made-up bakery newsletter: listing pages, a sitemap, robots.txt, eras, windows and pacing. |
| `test/read-a-link.test.mjs` | The link card: every picture, video and piece of structured data a page declares, a link that is itself a picture or video, the byte cap and the deadline, and the container tool's refusals. |
| `do-work/page-facts.mjs` | The one page reader, pure and runnable anywhere: `checkedUrl` (an http(s) address on its standard port with no user name or password) and `extractPage` (title, text, links, and the page's own card: description, pictures, videos, site, icon, structured data). |
| `do-work/page-conventions.json` | Which head tags and structured-data keys carry which fact (title, description, site, pictures, videos, icon), and how many of each are kept. |
| `do-work/browse_public_page.mjs` | The container tool `tool:read-public-web-page`: follows up to 5 redirects (never from https down to http), reads at most 2 MB, and answers `extractPage` of the page as JSON on stdout. |
| `do-work/walk-archive.mjs` | The archive walk, with its fetching and waiting injected: reads robots.txt and obeys it and its crawl delay, follows the listing's older links or a sitemap and its children (at most `max_listing_pages`), keeps the entries of the start address's own site, chooses by `window` (first and last day) or `eras` (early, middle, recent: equal thirds of the time between the oldest and newest day seen) with `count` entries from each era or in all, and reads them one at a time at least `delay_seconds` (2 or more) apart. A page that cannot be read is recorded and the walk goes on; every shortfall is said in `stopped` and `reached_oldest`. With `source: 'wayback'` the listing is the Wayback Machine's public CDX index of snapshots of the page at `url` (one per `collapse` period, in the window's days), and each chosen snapshot is read raw as archived; robots.txt, delay and own-site rules apply to web.archive.org. |
| `do-work/archive-facts.mjs` | The pure half of the walk: `listingEntries`, `nextListing`, `sitemapEntries`, `pageDate`, `dateOfUrl`, `dateInText`, `waybackQuery`, `cdxEntries`, `robotsRules`, `eraSpans`, `eraOf`, `evenlyDated`, `inWindow`. Which rels, link words, date tags and limits apply is `page-conventions.json` `archive`. |
| `do-work/read_a_link.mjs` | The container tool `tool:read-a-link`: `readLinkCard`, at most 2 MB and 6 seconds, the bare address with `unread` saying why when the link has no card. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `checkedUrl` | `(input: string) => URL` | Throws a plain-words error for anything but an http(s) page address on its standard port. |
| `extractPage` | `(body: string, base: URL \| string, plain?: boolean) => { title, text, links, description, image, images, videos, site, icon, data }` | Everything one page's bytes say; a fact the page does not state is null or empty. |
| `fileFacts` | `(address, mediaType) => { images, videos }` | What a link that is itself a picture or video adds. |
| `readPublicPage` | `(url, fetchPage?) => Promise<{ url, final_url, status, ...extractPage }>` | The page tool's read. |
| `readPublicPageOrArchive` | `({ url, walk? }, fetchPage?, sleep?) => Promise<readPublicPage answer + { walk }>` | What the page tool answers: the one-page read, plus `walk` (`listing_pages`, `entries_seen`, `dated`, `span`, `reached_oldest`, `eras`, `pages`, `requests`, `delay_seconds`, `stopped`) when `walk` is asked for. |
| `walkArchive` | `(url, walk, { read, sleep }) => Promise<{ first, walk }>` | The walk; `walk` is `{ source?: 'listing' \| 'wayback', collapse?, window?: { from, to }, eras?: ['early' \| 'middle' \| 'recent'], count?, max_listing_pages?, delay_seconds? }`. `count` 0 only measures the archive. |
| `readLinkCard` | `(url, { fetchPage?, waitMs? }) => Promise<{ url, final_url, host, site, title, description, image, images, videos, icon, data, text, unread }>` | The link tool's read; throws `ReadLinkError` only for an address that is not a web page address. |

## Dependencies

**Depends on:** nothing but the platform (`page-facts.mjs` uses no Node-only module; the two tools use Node's own `fetch`).

**Depended on by:** `tool-rows.json` (each row ships its tool, `page-facts.mjs` and `page-conventions.json` into the container), the old app's `src/read-link.mjs` (its link card), `test/browse-public-page.test.mjs`, `test/read-a-link.test.mjs`.

## Invariants

- No address rule lives here beyond the shape of a web address. Both tools run as internet:true rows, so Node's fetch reaches only the engine's public-only proxy, which judges every address, every redirect and every address a name resolves to; a refused hop reads as a page that did not answer.
- Bounded: at most 2 MB of a page, 30,000 characters of text and 100 links; the link card waits at most 6 seconds.
- The walk is polite and bounded: robots.txt first and obeyed (its crawl delay too), one request at a time, at least 2 seconds apart, only the start address's own site, at most 50 listing pages and 200 entry pages; a day it cannot read is null and an entry without a day is never in a window or an era.
