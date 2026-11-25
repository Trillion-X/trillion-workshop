// tools/publish-articles/do-work/rss.ts
//
// PURPOSE
//   The RSS 2.0 feed of a pursuit's published articles. `buildRss` is pure (cards in, XML text out, every value escaped);
//   `readFeed` reads the published cards and answers { xml }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every text and attribute value is XML-escaped; no value is ever placed in the feed as markup.
//   2. Only published articles are read (articles.ts owns that rule); the feed adds no row of its own.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import type { Reader } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';
import { readArticleList, type Card } from './articles.ts';

export type Channel = { title: string; description: string; origin: string; articles_path?: string };

const escapeXml = (value: string): string => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

export function buildRss(channel: Channel, articles: Card[]): string {
  const origin = new URL(channel.origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username) throw new TypeError('The feed origin must be an https origin with no path.');
  const base = `${origin.origin}${channel.articles_path ?? '/articles'}`;
  const items = articles.map(card => {
    const link = `${base}/${encodeURIComponent(card.slug)}`;
    const date = card.published_at ? `<pubDate>${new Date(card.published_at).toUTCString()}</pubDate>` : '';
    return `<item><title>${escapeXml(card.title)}</title><link>${escapeXml(link)}</link><guid isPermaLink="true">${escapeXml(link)}</guid>${date}<description>${escapeXml(card.description)}</description>${card.category ? `<category>${escapeXml(card.category)}</category>` : ''}</item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(channel.title)}</title><link>${escapeXml(base)}</link><description>${escapeXml(channel.description)}</description>${items}</channel></rss>`;
}

export const readFeed: Reader<{ database: string; channel: Channel }, { xml: string }> = async (input, rows) => {
  const { articles } = await readArticleList({ database: input.database, limit: 50 }, rows);
  return { xml: buildRss(input.channel, articles) };
};
