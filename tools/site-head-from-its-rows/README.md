# tools/site-head-from-its-rows/

The parts every page of a site carries in its head and at the start of its body, made from the site's own rows. The consent choice gates the tags: every visitor starts denied, a kept choice is applied before any tag runs, and the Accept / Decline bar is the only way to change it.

## Files

| File | Purpose |
|------|---------|
| `do-work/site-head.ts` | `siteHeadProblems(data)` lists every problem with a site's head data; `siteHeadMarkup(data)` makes the head markup (the consent default first, the bar's stylesheet, the declared parts in order, the bar) and the body-start markup; `withSiteHead(html, markup)` places them in a page. The default and the bar are the shared `tools/ui/show/consent-banner` part. |
| `reads/read-the-site-head.ts` | `tool:read-the-site-head {database, site}`: reads `site_head` and `site_head_parts`, checks them and answers `{ head, body_start }`. |
| `kits/read-the-site-head.json`, `tool-rows.json` | The kit and the card. |
| `test/site-head.test.ts` | The order (nothing before the consent default), the denied default, every refusal, the placing and the read. |

## Rules

- `consent.default` must be `denied`; a site without a consent block is refused.
- A part is `inline` (text) or `script` (an https `src`) in the head, or `noscript` (an https `src`) at the body start; its purpose must be one the site declares. The whole set is refused, with every problem named, when one part breaks a rule.
- No vendor is named here: the container and its tags are rows.

## Known gaps

- The site tool does not place this markup yet: it must call `tool:read-the-site-head` for the site and `withSiteHead` its pages.
