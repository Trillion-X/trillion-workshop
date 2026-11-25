// tools/publish-articles/do-work/articles.ts
//
// PURPOSE
//   The reads of the published articles of one pursuit: the list (newest first) and one article with its sections, the
//   articles to read next and the course it points to. These answers are the props of show/ArticleList.tsx and
//   show/Article.tsx, so a page and an AI's call draw the same thing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a row whose status is `published` and whose published_at has passed is answered. A draft is never read here.
//   2. Table and column names live in TABLES below and nowhere else.
//   3. Markdown is turned into data (sections of paragraphs and lists); no HTML is made here, so none can be injected.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import type { Reader } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';

export const TABLES = {
  articles: 'articles',
  courses: 'courses',
  published: "status = 'published' AND published_at IS NOT NULL AND published_at <= now()",
} as const;

export type Paragraph = { text: string } | { items: string[] };
export type Section = { heading: string | null; paragraphs: Paragraph[] };
export type Source = { n: number; title: string; label: string; excerpt: string; href: string };
export type Card = { slug: string; title: string; description: string; category: string; published_at: string | null };
export type Article = {
  slug: string; title: string; description: string; category: string; image: string | null; canonical: string | null;
  course: { slug: string; title: string } | null; course_cta: string | null;
  sections: Section[]; short_version: { text: string }[]; sources: Source[]; related: Card[];
  published_at: string | null; updated_at: string | null;
};
export type ArticleListAnswer = { articles: Card[] };
export type ArticleAnswer = { article: Article | null };

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : typeof value === 'string' && value ? value : null);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = <T>(value: unknown): T[] => {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  return Array.isArray(parsed) ? parsed as T[] : [];
};
const safeJson = (value: string): unknown => { try { return JSON.parse(value); } catch { return null; } };

// Markdown to sections: "## Heading" opens a section, a blank line ends a paragraph, "- item" lines make one list.
export function toSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: null, paragraphs: [] };
  let paragraph: string[] = [];
  let items: string[] = [];
  const endParagraph = () => { if (paragraph.length) current.paragraphs.push({ text: paragraph.join(' ') }); paragraph = []; };
  const endItems = () => { if (items.length) current.paragraphs.push({ items }); items = []; };
  const endSection = () => { endParagraph(); endItems(); if (current.heading !== null || current.paragraphs.length) sections.push(current); };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (heading) { endSection(); current = { heading: heading[1], paragraphs: [] }; }
    else if (item) { endParagraph(); items.push(item[1]); }
    else if (line === '') { endParagraph(); endItems(); }
    else { endItems(); paragraph.push(line); }
  }
  endSection();
  return sections;
}

const cardOf = (row: Record<string, unknown>): Card => ({
  slug: text(row.slug), title: text(row.title), description: text(row.description), category: text(row.category), published_at: iso(row.published_at),
});

export const readArticleList: Reader<{ database: string; limit?: number }, ArticleListAnswer> = async (input, rows) => {
  const limit = Number.isInteger(input.limit) && input.limit! > 0 && input.limit! <= 500 ? input.limit : 100;
  const found = await rows(
    `SELECT slug, title, description, category, published_at FROM ${TABLES.articles} WHERE ${TABLES.published} AND listed IS NOT FALSE ORDER BY published_at DESC, slug LIMIT $1`, [limit]);
  return { articles: found.map(cardOf) };
};

export const readArticle: Reader<{ database: string; slug: string }, ArticleAnswer> = async (input, rows) => {
  const [row] = await rows(`SELECT * FROM ${TABLES.articles} WHERE slug = $1 AND ${TABLES.published}`, [input.slug]);
  if (!row) return { article: null };
  const sections = list<Section>(row.sections);
  const relatedSlugs = list<unknown>(row.related).map(one => (typeof one === 'string' ? one : text((one as { slug?: unknown })?.slug))).filter(Boolean);
  const related = relatedSlugs.length
    ? await rows(`SELECT slug, title, description, category, published_at FROM ${TABLES.articles} WHERE slug = ANY($1::text[]) AND ${TABLES.published} AND slug <> $2`, [relatedSlugs, input.slug])
    : [];
  const courseSlug = text(row.course_slug);
  const [course] = courseSlug ? await rows(`SELECT slug, title FROM ${TABLES.courses} WHERE slug = $1`, [courseSlug]) : [];
  return {
    article: {
      ...cardOf(row),
      image: text(row.image) || text(row.picture) || null,
      canonical: text(row.canonical) || null,
      course: course ? { slug: text(course.slug), title: text(course.title) } : null,
      course_cta: text(row.course_cta) || null,
      sections: sections.length ? sections : toSections(text(row.body_markdown)),
      short_version: list<{ text: string }>(row.short_version),
      sources: list<Source>(row.sources),
      related: related.map(cardOf),
      updated_at: iso(row.updated_at),
    },
  };
};
