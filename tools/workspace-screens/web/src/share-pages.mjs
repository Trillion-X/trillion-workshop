// src/share-pages.mjs
//
// PURPOSE
//   The public page of someone's shared progress (/s/<code>), as DATA for the shared page writer
//   (parts/ui/show/server-rendered-page): the card picture, the numbers in words, and the invitation to try Trillion
//   through the join address that credits the person who shared it. The link preview (og and twitter tags) shows the
//   same picture. Every word is in progress-words.json; nothing here writes markup.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the share row's numbers appear (src/shares.mjs invariant 1); nothing identifies the person who shared.
//   2. The page asks not to be indexed: a share is sent to people, not published for search.
//   3. A link that was taken down says so plainly, with the invitation still there; a link with no card yet is the
//      invitation alone.

import { htmlPage } from './html-page.mjs';
import words from './progress-words.json' with { type: 'json' };
import { cardFor, headlineOf } from './progress-trends.mjs';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] ?? whole));
const html = (description, status = 200) => htmlPage({ robots: 'noindex', island: null, ...description }, { 'cache-control': 'public, max-age=60' }, status);

export const sharePath = code => `/s/${code}`;
// The picture's address carries when it was made, so a platform that cached an earlier picture fetches the new one.
export const picturePath = (code, share) => `/s/${code}/card.png${share?.picture_at ? `?v=${Date.parse(share.picture_at)}` : ''}`;

const invite = code => ({
  heading: words.page.cta_heading,
  body: words.page.cta_body,
  actions: [{ label: words.page.cta, href: `${sharePath(code)}/join`, tone: 'primary' }],
});

/** GET /s/<code>: the shared card and the invitation. `share` is the row from src/shares.mjs readShare. */
export function sharePage({ origin, code, share }) {
  if (!share) return html({ title: words.page.gone_title, sections: [{ heading: words.page.gone_title, heading_level: 1, body: words.page.gone_body }, invite(code)] }, 404);
  // A link whose person has not shared a card yet (every account has one, src/shares.mjs) is the invitation alone.
  if (!share.snapshot) return html({ title: words.page.invite_title, meta_description: words.page.cta_body, canonical_path: sharePath(code), sections: [{ ...invite(code), heading_level: 1, emphasis: 'hero' }] });
  const headline = headlineOf(share.snapshot);
  const card = cardFor(share.snapshot);
  const picture = share.picture_at ? `${origin}${picturePath(code, share)}` : null;
  const title = fill(words.page.title, { headline });
  return html({
    title,
    meta_description: words.page.description,
    canonical_path: sharePath(code),
    share: { type: 'website', site_name: 'Trillion', title, description: words.page.description, url: `${origin}${sharePath(code)}`, ...(picture ? { image: picture, image_alt: fill(words.page.image_alt, { headline }) } : {}) },
    sections: [
      {
        emphasis: 'hero',
        heading: headline,
        heading_level: 1,
        body: words.page.body,
        ...(picture ? { image: { src: picture, alt: fill(words.page.image_alt, { headline }) } } : {}),
        items: card.stats.map(stat => ({ heading: `${stat.label}: ${stat.value}`, ...(stat.detail ? { body: stat.detail } : {}) })),
      },
      invite(code),
    ],
  });
}
