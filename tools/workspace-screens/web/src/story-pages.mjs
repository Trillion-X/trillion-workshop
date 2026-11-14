// The public story pages as DATA for the shared page writer (parts/ui/show/server-rendered-page), plus the plain-text
// documents search and answer engines read: the stories' sitemap and llms.txt (gettrillion.ai names both in its own
// robots.txt and llms.txt).
//
// /stories            every story, newest first, filtered by kind (?kind=), a page at a time (?after=), growing as the
//                     reader scrolls
// /stories/<id>       one story at its permanent address, with the invitation to start and more stories beside it
//
// Every word comes from story-settings.json `words`, the story itself, or the offer rows the visitor is shown (plan
// names and prices are never written here). Nothing here writes markup.
import { htmlPage } from './html-page.mjs';
import settings from './story-settings.json' with { type: 'json' };

const { words, kinds } = settings;
const kindLabel = id => id === 'insight' ? 'Shared insights' : kinds.find(kind => kind.id === id)?.label ?? kinds.find(kind => kind.fallback)?.label ?? '';
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);
const day = iso => (typeof iso === 'string' && iso.length >= 10 ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const TONES = { met: 'good', failed: 'attention' };
/** When a story was published and last changed, for the page's date line and the meta tags engines read. */
const storyDates = story => ({
  published: story.published_on ? { label: words.date_published, iso: story.published_on, text: day(story.published_on) } : null,
  modified: story.updated_on ? { label: words.date_updated, iso: story.updated_on, text: day(story.updated_on) } : null,
});
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The address of a story, and of a feed page, on the public site. */
export const storyPath = id => `/stories/${id}`;
export const feedPath = ({ kind = null, after = null } = {}) => {
  const query = new URLSearchParams({ ...(kind ? { kind } : {}), ...(after !== null && after !== undefined ? { after: String(after) } : {}) }).toString();
  return `/stories${query ? `?${query}` : ''}`;
};

/** How a result reads on a story and its card. */
export const outcomeMeta = story => {
  const result = story.outcome?.result ?? 'unknown';
  return { label: words.results[result] ?? words.results.unknown, tone: TONES[result] ?? 'quiet' };
};

/** Keep the offer's price words, including its unit and usage terms; format older unlabeled options. */
export function priceWords(option) {
  if (typeof option.label === 'string' && option.label.trim()) return option.label.trim();
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: String(option.currency ?? 'usd').toUpperCase(), minimumFractionDigits: option.amount_cents % 100 ? 2 : 0 }).format(option.amount_cents / 100);
  return option.interval ? `${amount}/${option.interval}` : amount;
}

/**
 * The invitation to start, from the offers this visitor is shown (src/visitor-offers.mjs offersForVisitor): the
 * free plan by its name and what it includes, and the recommended paid plan by its name and price.
 */
export function inviteSection(offers, accountHref) {
  const paidOption = offer => (offer.options ?? []).find(option => option.amount_cents > 0);
  const free = offers.find(offer => !paidOption(offer));
  const paid = offers.find(offer => offer.recommended && paidOption(offer)) ?? offers.find(offer => paidOption(offer));
  const freeValue = free?.features?.find(feature => feature.included && feature.value)?.value;
  const lines = [
    words.cta_body,
    free ? `${free.label} is free${freeValue ? `: ${freeValue}` : ''}.` : null,
    paid ? `${paid.label} is ${priceWords(paidOption(paid))}.` : null,
  ].filter(Boolean);
  return {
    emphasis: 'invite',
    heading: words.cta_heading,
    body: lines.join(' '),
    actions: [
      { label: words.cta_free, href: accountHref, tone: 'primary' },
      ...(paid ? [{ label: fill(words.cta_paid, { plan: paid.label, price: priceWords(paidOption(paid)) }), href: accountHref, tone: 'quiet' }] : []),
    ],
  };
}

/** A story as a card in the feed. */
export const storyCard = story => ({
  heading: story.title,
  body: story.summary || story.situation || story.insight,
  details: story.kind === 'insight' ? [`${story.sources.length} sources to check`] : [`${words.card_decided}: ${story.chosen}`],
  ...(story.kind === 'insight' ? {} : { meta: outcomeMeta(story) }),
  href: storyPath(story.id),
});

const html = (description, headers = {}) => htmlPage({ island: null, ...description }, { 'cache-control': `public, max-age=${settings.fresh_seconds}`, ...headers });

const shareImage = origin => `${origin}/stories/share.png`;

/**
 * GET /stories: one page of stories. `page` is `{ stories, next }` from the pool; `counts` is how many stories each
 * kind holds; `kind` the filter in use. A page after the first is for readers who scroll, not for search engines.
 */
export function feedPage({ canonicalOrigin, page, counts, kind = null, after = null, offers, accountHref }) {
  const insightsOnly = kind === 'insight';
  const description = insightsOnly ? 'Approved insights with their sources, exact quotes, method, data and traceable chain.' : words.feed_description;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const newest = page.stories.map(story => story.updated_on).filter(Boolean).sort().at(-1) ?? null;
  const chips = [
    { label: words.all_kinds, href: feedPath(), count: total, selected: !kind },
    ...kinds.filter(row => counts[row.id] || row.id === kind).map(row => ({ label: row.label, href: feedPath({ kind: row.id }), count: counts[row.id] ?? 0, selected: row.id === kind })),
    ...((counts.insight || kind === 'insight') ? [{ label: 'Shared insights', href: feedPath({ kind: 'insight' }), count: counts.insight ?? 0, selected: kind === 'insight' }] : []),
  ];
  const cards = page.stories.map(storyCard);
  // After the fourth story of the first page, one card invites the reader to start, as a showcase does.
  const invite = inviteSection(offers, accountHref);
  if (after === null && cards.length > 4) cards.splice(4, 0, { tone: 'invite', heading: invite.heading, body: invite.body, href: accountHref });
  const title = kind ? `${kindLabel(kind)} · ${words.feed_title}` : words.feed_title;
  return html({
    title,
    meta_description: description,
    canonical_origin: canonicalOrigin,
    canonical_path: feedPath({ kind }),
    robots: after === null ? 'index, follow' : 'noindex, follow',
    layout: 'browse',
    dates: { modified: newest ? { label: words.date_updated, iso: newest, text: day(newest) } : null },
    share: { type: 'website', site_name: 'Trillion', title, description, url: `${canonicalOrigin}${feedPath({ kind })}`, image: shareImage(canonicalOrigin), image_alt: insightsOnly ? 'Insights you can check' : words.feed_heading },
    structured_data: [{
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: title,
      description,
      url: `${canonicalOrigin}${feedPath({ kind })}`,
      publisher: { '@type': 'Organization', name: 'Trillion', url: canonicalOrigin },
      mainEntity: { '@type': 'ItemList', itemListElement: page.stories.map((story, index) => ({ '@type': 'ListItem', position: index + 1, url: `${canonicalOrigin}${storyPath(story.id)}`, name: story.title })) },
    }],
    sections: [
      { emphasis: 'hero',
        heading: insightsOnly ? 'Insights you can check' : words.feed_heading, heading_level: 1,
        body: insightsOnly ? description : words.feed_body, chips },
      ...(after === null ? [{ heading: words.feed_what_heading, body: words.feed_what_body }] : []),
      cards.length
        ? { emphasis: 'feed', cards, ...(page.next !== null ? { more: { label: words.more, href: feedPath({ kind, after: page.next }) } } : {}) }
        : { emphasis: 'feed', body: insightsOnly ? 'No insights shared yet.' : words.empty },
      ...(page.next === null ? [invite] : []),
    ],
  });
}

/** GET /stories/<id>: one story, the invitation to start, and more stories. */
export function storyPage({ canonicalOrigin, story, related, offers, accountHref }) {
  if (story.kind === 'insight') return insightPage({ canonicalOrigin, story, related, offers, accountHref });
  const url = `${canonicalOrigin}${storyPath(story.id)}`;
  const outcome = story.outcome?.what_happened ?? words.outcome_waiting;
  const faq = [
    [words.faq_situation, story.situation],
    [words.faq_weighed, story.options.join('; ')],
    [words.faq_decided, `${story.chosen}. ${story.why}`],
    ...(story.outcome ? [[words.faq_outcome, story.outcome.what_happened]] : []),
  ];
  return html({
    title: `${story.title} · Trillion`,
    meta_description: story.summary || story.situation,
    canonical_origin: canonicalOrigin,
    canonical_path: storyPath(story.id),
    robots: 'index, follow',
    layout: 'reader',
    share: { type: 'article', site_name: 'Trillion', title: story.title, description: story.summary || story.situation, url, image: shareImage(canonicalOrigin), image_alt: story.title },
    structured_data: [
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: story.title,
        description: story.summary || story.situation,
        articleSection: kindLabel(story.kind),
        datePublished: story.published_on,
        dateModified: story.updated_on,
        mainEntityOfPage: url,
        url,
        image: shareImage(canonicalOrigin),
        author: { '@type': 'Organization', name: 'Trillion', url: canonicalOrigin },
        publisher: { '@type': 'Organization', name: 'Trillion', url: canonicalOrigin },
        articleBody: [story.situation, story.why, story.outcome?.what_happened].filter(Boolean).join(' '),
      },
      { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })) },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: words.feed_name, item: `${canonicalOrigin}${feedPath()}` },
          { '@type': 'ListItem', position: 2, name: kindLabel(story.kind), item: `${canonicalOrigin}${feedPath({ kind: story.kind })}` },
          { '@type': 'ListItem', position: 3, name: story.title, item: url },
        ],
      },
    ],
    sections: [
      { emphasis: 'story', heading: story.title, heading_level: 1, body: [story.summary, words.story_what].filter(Boolean).join(' ') },
      { heading: words.situation, body: story.situation },
      { heading: words.weighed, items: story.options.map(option => ({ heading: option, ...(same(option, story.chosen) ? { meta: { label: words.chosen_mark, tone: 'good' } } : {}) })) },
      { heading: words.decided, body: story.chosen },
      { heading: words.why, body: story.why },
      ...(story.next_step ? [{ heading: words.next_step, body: story.next_step }] : []),
      ...(story.measured_by ? [{ heading: words.measured_by, body: story.measured_by }] : []),
      { heading: words.outcome, body: outcome, items: story.outcome ? [{ heading: outcomeMeta(story).label, meta: outcomeMeta(story) }] : [] },
      // The shared share row (parts/ui/show/share-row): Copy link, X, LinkedIn and the phone's share sheet.
      { share: { url, text: story.title } },
      { emphasis: 'fine', body: words.anonymous_note },
    ],
    dates: storyDates(story),
    aside: [
      inviteSection(offers, accountHref),
      { heading: words.more_like_this, cards: related.map(storyCard), actions: [{ label: words.all_stories, href: feedPath(), tone: 'quiet' }] },
    ],
  });
}

function insightPage({ canonicalOrigin, story, related, offers, accountHref }) {
  const url = `${canonicalOrigin}${storyPath(story.id)}`;
  return html({
    title: `${story.title} · Trillion`,
    meta_description: story.summary || story.insight,
    canonical_origin: canonicalOrigin,
    canonical_path: storyPath(story.id),
    robots: 'index, follow',
    layout: 'reader',
    share: { type: 'article', site_name: 'Trillion', title: story.title, description: story.summary || story.insight, url, image: shareImage(canonicalOrigin), image_alt: story.title },
    structured_data: [{ '@context': 'https://schema.org', '@type': 'Article', headline: story.title,
      datePublished: story.published_on, dateModified: story.updated_on, url,
      articleBody: [story.insight, story.method, story.data, story.trace].join(' '),
      citation: story.sources.map(source => source.url),
      publisher: { '@type': 'Organization', name: 'Trillion', url: canonicalOrigin } }],
    sections: [
      { emphasis: 'story', heading: story.title, heading_level: 1, body: [story.insight, words.story_what].filter(Boolean).join(' ') },
      { heading: 'How it was reached', body: story.method },
      { heading: 'Data checked', body: story.data },
      { heading: 'Traceable chain', body: story.trace },
      { heading: 'Sources and exact quotes', items: story.sources.map((source, index) => ({ heading: `Source ${index + 1}`, body: source.quote, actions: [{ label: source.url, href: source.url, tone: 'quiet' }] })) },
      { share: { url, text: story.title } },
    ],
    dates: storyDates(story),
    aside: [inviteSection(offers, accountHref),
      { heading: words.more_like_this, cards: related.map(storyCard), actions: [{ label: words.all_stories, href: feedPath(), tone: 'quiet' }] }],
  });
}

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** GET /stories/sitemap.xml: the feed and every story, each with the day it last changed. */
export function sitemap(canonicalOrigin, index) {
  const rows = [{ loc: `${canonicalOrigin}${feedPath()}`, lastmod: index[0]?.updated_on ?? null }, ...index.map(row => ({ loc: `${canonicalOrigin}${storyPath(row.id)}`, lastmod: row.updated_on }))];
  const body = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...rows.map(row => `<url><loc>${xml(row.loc)}</loc>${row.lastmod ? `<lastmod>${xml(row.lastmod)}</lastmod>` : ''}</url>`), '</urlset>'].join('\n');
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': `public, max-age=${settings.fresh_seconds}` } });
}

/** GET /stories/llms.txt: what Trillion is, and the stories, for AI assistants and answer engines. */
export function llmsText(canonicalOrigin, stories) {
  const body = [
    '# Trillion',
    '',
    `> ${words.llms_tagline}`,
    '',
    words.feed_body,
    '',
    `## ${words.feed_name}`,
    '',
    `- [${words.feed_heading}](${canonicalOrigin}${feedPath()}): ${words.feed_description}`,
    ...stories.map(story => `- [${story.title}](${canonicalOrigin}${storyPath(story.id)}): ${story.summary || story.situation || story.insight}`),
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${settings.fresh_seconds}` } });
}
