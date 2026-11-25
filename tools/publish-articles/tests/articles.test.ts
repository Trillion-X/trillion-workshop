import test from 'node:test';
import assert from 'node:assert/strict';
import { readArticle, readArticleList, toSections, TABLES } from '../do-work/articles.ts';

const rowsFor = (answers: Record<string, Record<string, unknown>[]>, seen: { sql: string; params?: unknown[] }[] = []) => async (sql: string, params?: unknown[]) => {
  seen.push({ sql, params });
  const key = Object.keys(answers).find(name => sql.includes(`FROM ${name}`));
  return key ? answers[key] : [];
};

test('markdown becomes sections of paragraphs and lists, with no html made', () => {
  const sections = toSections('Intro line one\nline two\n\n## Why\n\n- a\n- b\n\nAfter <script>x</script>');
  assert.deepEqual(sections, [
    { heading: null, paragraphs: [{ text: 'Intro line one line two' }] },
    { heading: 'Why', paragraphs: [{ items: ['a', 'b'] }, { text: 'After <script>x</script>' }] },
  ]);
});

test('the list asks only for published, listed rows, newest first, and answers cards', async () => {
  const seen: { sql: string; params?: unknown[] }[] = [];
  const answer = await readArticleList({ database: 'd', limit: 5 }, rowsFor({ [TABLES.articles]: [{ slug: 'a', title: 'A', description: 'd', category: 'c', published_at: new Date('2026-01-02T00:00:00Z') }] }, seen));
  assert.deepEqual(answer.articles, [{ slug: 'a', title: 'A', description: 'd', category: 'c', published_at: '2026-01-02T00:00:00.000Z' }]);
  assert.match(seen[0].sql, /status = 'published'/);
  assert.match(seen[0].sql, /ORDER BY published_at DESC/);
  assert.deepEqual(seen[0].params, [5]);
});

test('an article answers sections, related cards and its course; a missing slug answers null', async () => {
  const row = { slug: 'a', title: 'A', description: 'd', category: 'c', body_markdown: '## H\n\nWords', related: ['b', { slug: 'c' }], course_slug: 'x', course_cta: 'Go', short_version: [{ text: 's' }], sources: '[]', image: null, picture: 'p.png', published_at: '2026-01-02T00:00:00Z' };
  const seen: { sql: string; params?: unknown[] }[] = [];
  const rows = async (sql: string, params?: unknown[]) => {
    seen.push({ sql, params });
    if (sql.includes(`FROM ${TABLES.courses}`)) return [{ slug: 'x', title: 'X' }];
    if (sql.includes('slug = ANY')) return [{ slug: 'b', title: 'B', description: '', category: '', published_at: null }];
    return [row];
  };
  const { article } = await readArticle({ database: 'd', slug: 'a' }, rows);
  assert.equal(article?.course?.title, 'X');
  assert.equal(article?.image, 'p.png');
  assert.deepEqual(article?.sections, [{ heading: 'H', paragraphs: [{ text: 'Words' }] }]);
  assert.deepEqual(article?.related.map(card => card.slug), ['b']);
  assert.deepEqual(seen[1].params, [['b', 'c'], 'a']);
  assert.ok(seen.every(one => !one.sql.includes('FROM articles') || one.sql.includes("status = 'published'")), 'every article read is published-only');
  assert.deepEqual(await readArticle({ database: 'd', slug: 'none' }, async () => []), { article: null });
});

test('the stored sections win over the markdown', async () => {
  const stored = [{ heading: 'Own', paragraphs: [{ text: 'T' }] }];
  const { article } = await readArticle({ database: 'd', slug: 'a' }, rowsFor({ [TABLES.articles]: [{ slug: 'a', title: 'A', sections: stored, body_markdown: 'ignored' }] }));
  assert.deepEqual(article?.sections, stored);
});
