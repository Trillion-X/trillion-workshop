// tools/share-links/do-work/read-link-page.mjs
//
// tool:read-link-page: the Link in bio facts for one page. The page's owner reads the page as values
// (tools/keep-a-link-in-bio-page read-data/link-page.mjs makeLinkPage, read()), and the facts (web/src/link-page-screen.mjs
// linkPageFacts) shape that read. Ported from the old codebase's read-link-page (commit b6ae0ebf815f). Nothing here reads a
// store: the caller hands in the page's own record, its counts and its posts, and the address it is read at.
import { makeLinkPage } from '../../keep-a-link-in-bio-page/read-data/link-page.mjs';
import { linkPageFacts } from '../web/src/link-page-screen.mjs';
import settings from '../web/src/link-page.json' with { type: 'json' };

const NAMES_WORDS = { not_here: 'Names are not available on this account.' };

/** The Link in bio facts for `page` (the person's page record), its `counts` and `posts`, at `origin` (the address it is read at). */
export function readLinkPage({ page = null, counts = [], posts = [], origin = '' } = {}) {
  return linkPageFacts(makeLinkPage({ page, counts, posts, settings, origin: () => origin, namesWords: NAMES_WORDS }).read());
}
