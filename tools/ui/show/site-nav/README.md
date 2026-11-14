# site-nav

One top navigation for a whole site, drawn from one nav DATA row, so a page drawn in React and a page a server sends ready to read show the same items in the same order, with the same look and behaviour.

## Files

| File | Purpose |
|---|---|
| `site-nav-look.mjs` | `siteNavEntries` (the one reading of the nav DATA both renderers draw from), `siteNavItems` (every destination in reading order, what a test compares), `siteNavHover` (the mouse-hover timing and pointer path, the one copy both renderers run), `SITE_NAV_CSS` (the look, theme role tokens only), `SITE_NAV_SCRIPT` (open and close on server-sent pages; carries `siteNavHover`'s source) |
| `site-nav-look.d.mts` | Types for `site-nav-look.mjs` |
| `SiteNav.tsx` | The React renderer: same classes, same `data-nav-item` marks, same CSS; the caller gives the brand and may draw the primary action in its own look |

The server-sent renderer is `headerHtml` in `../document-page/document-page-html.mjs` (only that folder writes tags for server pages).

## Key Types / Functions

| Name | Shape | Role |
|---|---|---|
| nav DATA | `{ label, items: [{ label, href } \| { label, menu: { heading, items: [{ id, name, line, icon, href, preview: { src, alt, width, height } }], footer: { label, line, href } } }], actions: [{ label, href, primary }] }` | An entry with `menu` opens a menu of feature rows with an icon and one plain line; rows with a `preview` also show a picture beside the list; `footer` is the menu's closing link (e.g. all new features). `primary: true` marks the call to action. |
| `siteNavEntries(nav)` | nav -> `{ label, items, actions }` | Drops rows missing a name or address; gives each menu its element id |
| `siteNavItems(nav)` | nav -> `[{ label, href }]` | Menu button (href `null`), its features, its footer, links, actions, in reading order |
| `SiteNav` | `{ nav, icons: { name: [[shape, attributes]] }, brand, renderPrimary?, toggleLabel? }` | React navbar |
| `siteNavHover(item, api, delays?)` | element, `{ isOpen, isSoft, show, hide }` -> `{ cancel, destroy }` | Mouse hover for one menu item: opens softly after 120 ms of rest, closes a softly opened menu 180 ms after the pointer leaves, and keeps waiting while the pointer is inside the triangle from where it left to the card's top edge. Whole in itself, so the script can carry its source. |
| `SITE_NAV_CSS` / `SITE_NAV_SCRIPT` | strings | The shared look; the server page's open-and-close script |

Icons travel as shape rows (the Lucide icon-node form, resolved from each row's `icon` name by the caller's build), so both renderers draw the same icon without bundling an icon library.

A text brand marked `data-brand-text="wordmark"` uses the shared display font at weight 600 and 24px. The document renderer selects it only for `header.brand.text_style: "wordmark"`; existing text and image brands keep their appearance.

## Invariants

- No item kinds in code: a new link, feature, preview or action is a DATA row.
- Every colour is a theme role token (`--ink`, `--thread`, `--grey-strong`, `--grey-soft`, `--surface-base`, `--paper-tint`, `--on-accent`, `--focus-ring`).
- Open state lives only in `aria-expanded` on a button that names what it opens; without the script a server page still opens menus on hover and focus and shows the whole nav on a narrow screen.
- A link to a section of a page (`/#pricing`) glides there: on the same page the click scrolls smoothly instead of jumping, and arriving from another page the scroll follows the section while the page above it finishes drawing, stopping the moment the person scrolls, presses a key or touches the page (`useSectionLinks` in `SiteNav.tsx`). Reduced motion jumps instead of gliding. Each link and action underlines in the thread colour on hover and keyboard focus.
- Behaviour: hover (mouse, after 120 ms of rest) or keyboard focus opens a menu softly; leaving a softly opened menu closes it after 180 ms, and the close keeps waiting while the pointer is inside the triangle from where it left to the card's top edge; a click keeps it open, a second click closes; a tap opens; Escape closes and returns focus; a press outside closes. The timing and the path are `siteNavHover`, called by `SiteNav.tsx` and carried in source form by `SITE_NAV_SCRIPT`, so the two renderers cannot drift. (Base UI `PreviewCard`, as `surface-preview` uses, was not used: the server-sent pages run no React, and the menu's open state must stay the single `aria-expanded` the CSS draws from.)
- The visible gap between a menu button and its card is 8px. The invisible bridge across it is exactly the card's width (not the nav's), so page margins beside the card do not keep a menu open; the card stays centred at 880px. Under 900px the nav folds behind one Menu button and Features opens in place under its button.

## Dependencies

**Depends on:** `react` (SiteNav only).

**Depended on by:** `../document-page/document-page-html.mjs` (every server-sent page's header), `dev/trillion-site` (the gettrillion.ai landing and every Worker page, nav DATA in `worker/data/site-nav.json`). Tested by `test/document-page.test.mjs` and `dev/trillion-site/test/site-nav.test.mjs`.
