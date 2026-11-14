import assert from 'node:assert/strict';
import test from 'node:test';
import { composeArchiveArticleDiscovery } from './compose-article-discovery.mjs';

const articles = Array.from({ length: 7 }, (_, index) => ({
  id: `article:${index + 1}`,
  kind: 'public-sales-page',
  route_path: `/article/story-${index + 1}`,
  title: `Story ${index + 1}`,
  meta_description: `A useful summary for story ${index + 1}.`,
  eyebrow: 'Gardening',
  schema: { '@type': 'Article' },
  image_url: `/assets/story-${index + 1}.jpg`,
}));

const collection = {
  id: 'page:articles',
  kind: 'public-sales-page',
  route_path: '/articles',
  schema: { '@type': 'CollectionPage' },
  article_discovery: { kind: 'published-articles' },
  blocks: [{ kind: 'card-grid', items: [] }],
};

test('collection and related cards discover an eighth reviewed Article from the archive', () => {
  const eighth = {
    id: 'article:8',
    kind: 'public-sales-page',
    route_path: '/article/story-8',
    title: 'Story 8',
    meta_description: 'A fresh summary for the newly published article.',
    eyebrow: 'Gardening',
    image_url: '/assets/story-8.jpg',
    source_refs: ['lesson:shared'],
    schema: { '@type': 'Article' },
    blocks: [{ kind: 'paragraph', text: 'Reviewed article content.' }],
  };
  const archive = [...articles, eighth, collection];

  const [updatedCollection] = composeArchiveArticleDiscovery([collection], archive, '/articles');
  const collectionCards = updatedCollection.blocks.find((block) => block.kind === 'card-grid').items;
  assert.equal(collectionCards.length, 8);
  assert.deepEqual(collectionCards[0], {
    id: 'article:1', title: 'Story 1', text: 'A useful summary for story 1.',
    eyebrow: 'Gardening', href: '/article/story-1', action: 'Read article', thumbnail_url: '/assets/story-1.jpg',
  });
  assert.deepEqual(collectionCards[7], {
    id: 'article:8', title: 'Story 8', text: 'A fresh summary for the newly published article.',
    eyebrow: 'Gardening', href: '/article/story-8', action: 'Read article', thumbnail_url: '/assets/story-8.jpg',
  });

  const existingArticle = { ...articles[0], source_refs: ['lesson:shared'], blocks: [{ kind: 'card-grid', items: [] }] };
  archive[0] = existingArticle;
  const [updatedExisting] = composeArchiveArticleDiscovery([existingArticle], archive, existingArticle.route_path);
  const related = updatedExisting.blocks[0].items;
  assert.equal(related.some((card) => card.href === eighth.route_path), true);
  assert.equal(related.some((card) => card.href === existingArticle.route_path), false);

  const [updatedEighth] = composeArchiveArticleDiscovery([eighth], archive, eighth.route_path);
  assert.equal(updatedEighth.blocks[1].kind, 'card-grid');
  assert.equal(updatedEighth.blocks[1].items.some((card) => card.href === existingArticle.route_path), true);
});

test('marked sitemap and llms raw routes derive article entries from the reviewed archive', () => {
  const eighth = {
    id: 'article:8', route_path: '/article/story-8', title: 'Story 8',
    schema: { '@type': 'Article' },
  };
  const sitemap = {
    route_path: '/sitemap.xml', content_type: 'application/xml',
    article_discovery: { kind: 'published-articles' },
    body_text: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://example.test/</loc></url>\n  <url><loc>https://example.test/article/story-1</loc></url>\n</urlset>',
  };
  const llms = {
    route_path: '/llms.txt', content_type: 'text/plain',
    article_discovery: { kind: 'published-articles' },
    body_text: '# School\n\n## Public pages\n- https://example.test/ — Home\n- https://example.test/article/story-1 — Old title\n\nArticles cite teaching sources.\n',
  };
  const archive = [...articles, eighth];
  const [projectedSitemap] = composeArchiveArticleDiscovery([sitemap], archive, '/sitemap.xml');
  const [projectedLlms] = composeArchiveArticleDiscovery([llms], archive, '/llms.txt');
  assert.match(projectedSitemap.body_text, /https:\/\/example\.test\/article\/story-8/);
  assert.doesNotMatch(projectedSitemap.body_text, /sitemaps\.org\/article\//);
  assert.equal((projectedSitemap.body_text.match(/https:\/\/example\.test\/article\/story-1/g) ?? []).length, 1);
  assert.match(projectedLlms.body_text, /https:\/\/example\.test\/article\/story-8 — Story 8/);
  assert.doesNotMatch(projectedLlms.body_text, /Old title/);
  assert.match(projectedLlms.body_text, /Articles cite teaching sources\./);
});

test('an older live raw record follows the marked archive and drops withdrawn article links', () => {
  const oldLive = {
    route_path: '/sitemap.xml', content_type: 'application/xml',
    body_text: '<urlset>\n  <url><loc>https://example.test/</loc></url>\n  <url><loc>https://example.test/article/withdrawn</loc></url>\n</urlset>',
  };
  const markedArchive = {
    ...oldLive, article_discovery: { kind: 'published-articles', route_prefix: '/article/' },
  };
  const [projected] = composeArchiveArticleDiscovery(
    [oldLive], [markedArchive, ...articles], '/sitemap.xml');
  assert.doesNotMatch(projected.body_text, /withdrawn/);
  assert.match(projected.body_text, /https:\/\/example\.test\/article\/story-1/);
});
