// tools/share-links/do-work/read-link-page.mjs
//
// The Link in bio screen's facts for one page: the page's owner reads the page as values (tools/keep-a-link-in-bio-page
// read-data/link-page.mjs makeLinkPage, read()), and the screen's facts (web/src/link-page-screen.mjs linkPageFacts) shape
// that read. Ported from the old codebase read-link-page (src/account-action-domain.mjs, src/link-page-screen.mjs), which
// joined the same two; nothing here reads a store: the caller hands in the page's own rows and counts.
import { makeLinkPage } from '../../keep-a-link-in-bio-page/read-data/link-page.mjs';
import { linkPageFacts } from '../web/src/link-page-screen.mjs';

/** The Link in bio facts for `page` (the person's page record), its `counts` and `posts`, at `origin` (the address it is read at). */
export function readLinkPage({ page = null, counts = [], posts = [], settings, origin, names = null, namesWords, now, random }) {
  return linkPageFacts(makeLinkPage({ page, counts, posts, settings, origin, names, namesWords, now, random }).read());
}
