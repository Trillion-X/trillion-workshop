// The two Views drawn to static markup. Node cannot read JSX, so the Views are bundled by esbuild (as the neighbouring tools'
// tests do) with a small entry that renders each one from fixture props and answers the markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type { Article as ArticleData } from '../do-work/articles.ts';

const here = new URL('..', import.meta.url).pathname;

const article: ArticleData = {
  slug: 'a', title: 'A fine title', description: 'About it', category: 'Cat', image: null, canonical: null,
  course: { slug: 'c', title: 'See the course' }, course_cta: 'Keep going',
  sections: [{ heading: 'Why', paragraphs: [{ text: 'Plain **bold** [site](https://example.com) [bad](javascript:alert(1)) [n](#source-1) <script>x</script>' }, { items: ['one'] }] }],
  short_version: [{ text: 'short' }], sources: [{ n: 1, title: 'S', label: 'L', excerpt: 'E', href: 'https://example.com/s' }],
  related: [{ slug: 'b', title: 'Next', description: 'nd', category: '', published_at: null }], published_at: '2026-01-02T00:00:00Z', updated_at: null,
};

const entry = (show: string) => `
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { View as Article } from '${show}/Article.tsx';
import { View as ArticleList } from '${show}/ArticleList.tsx';
export const draw = (name, props) => renderToStaticMarkup(createElement(name === 'article' ? Article : ArticleList, props));
`;

const built = await build({
  stdin: { contents: entry(`${here}show`), resolveDir: here, loader: 'js' }, bundle: true, write: false, format: 'cjs', platform: 'node',
  jsx: 'automatic', logLevel: 'silent',
});
const loaded = { exports: {} as { draw: (name: string, props: unknown) => string } };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(loaded, loaded.exports, createRequire(import.meta.url));
const { draw } = loaded.exports;

test('an article draws its words, sources, related and course; markup and unsafe links are text or dropped', () => {
  const html = draw('article', { article });
  for (const part of ['About it', 'Why', '>bold</strong>', 'href="https://example.com"', 'The short version', 'id="source-1"', 'Read next', 'href="/articles/b"', 'href="/courses/c"', '2026-01-02']) assert.ok(html.includes(part), part);
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('a missing article draws only the not-found words', () => {
  assert.ok(draw('article', { article: null, not_found: 'Gone' }).includes('Gone'));
});

test('the list links each article and shows the empty words when there are none', () => {
  const html = draw('list', { heading: 'All articles', articles: [{ slug: 'x y', title: 'T', description: 'D', category: '', published_at: null }] });
  assert.ok(html.includes('href="/articles/x%20y"'));
  assert.ok(draw('list', { heading: 'All articles', articles: [], empty: 'Nothing yet' }).includes('Nothing yet'));
});
