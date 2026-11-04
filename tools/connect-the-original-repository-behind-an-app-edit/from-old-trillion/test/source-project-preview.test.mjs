import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyPreviewRequest, sourcePreviewTarget, sourcePreviewPageMatches, sourcePreviewRoutes, sourceSitemapRoutes } from '../../../refresh-one-page-of-a-copied-site-from-its-original/src/source-project-preview.mjs';

test('route discovery keeps clean links within the connected app and one base path', () => {
  assert.deepEqual(sourcePreviewRoutes('https://app.example.com/', [
    'https://app.example.com/', 'https://app.example.com/for-you', 'https://app.example.com/articles/one/',
    'https://app.example.com/about?tab=private', 'https://app.example.com/#pricing',
    'https://elsewhere.example/about', 'https://app.example.com/%2e%2e/private',
  ]), ['/', '/articles/one/', '/for-you']);
  assert.deepEqual(sourcePreviewRoutes('https://pages.example.com/my-app/', [
    'https://pages.example.com/my-app/', 'https://pages.example.com/my-app/about/',
    'https://pages.example.com/other-app/about/',
  ]), ['/', '/about/']);
});

test('a sitemap adds nested routes but cannot add another app or follow redirects', async () => {
  const calls = [];
  const routes = await sourceSitemapRoutes('https://pages.example.com/my-app/', async (url, options) => {
    calls.push({ url, options });
    return new Response('<urlset><url><loc>https://pages.example.com/my-app/for-you</loc></url><url><loc>https://pages.example.com/my-app/features/people</loc></url><url><loc>https://pages.example.com/other-app/private</loc></url></urlset>',
      { headers: { 'content-type': 'application/xml' } });
  });
  assert.deepEqual(routes, ['/', '/features/people', '/for-you']);
  assert.equal(calls[0].url, 'https://pages.example.com/my-app/sitemap.xml');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(await sourceSitemapRoutes('https://app.example.com/', async () =>
    new Response(null, { status: 302, headers: { location: 'https://other.example/sitemap.xml' } })), []);
});

test('preview route cannot change the connected origin through backslashes or absolute URLs', () => {
  const base = 'https://preview.example.com/';
  assert.equal(sourcePreviewTarget(base, '/about/')?.href, 'https://preview.example.com/about/');
  assert.equal(sourcePreviewTarget(base, '/\\127.0.0.1/'), null);
  assert.equal(sourcePreviewTarget(base, '//127.0.0.1/'), null);
  assert.equal(sourcePreviewTarget('https://127.0.0.1/', '/'), null);
  assert.equal(sourcePreviewTarget('https://preview.example.com./', '/'), null);
});

test('preview routes stay inside a connected app hosted below the origin', () => {
  const base = 'https://sample-owner.github.io/riverside-legal/';
  assert.equal(sourcePreviewTarget(base, '/')?.href, base);
  assert.equal(sourcePreviewTarget(base, '/about/')?.href, `${base}about/`);
  assert.equal(sourcePreviewTarget('https://sample-owner.github.io/riverside-legal', '/')?.href, base);
  assert.equal(sourcePreviewTarget(base, '/../other-app/'), null);
  assert.equal(sourcePreviewTarget(base, '/%2e%2e/other-app/'), null);
  assert.equal(sourcePreviewPageMatches(base, `${base}about/`), true);
  assert.equal(sourcePreviewPageMatches(base, 'https://sample-owner.github.io/other-app/'), false);
  assert.equal(sourcePreviewPageMatches(base, 'https://sample-owner.github.io/riverside-legalish/'), false);
});

test('browser requests are fulfilled only by the strictly public same-origin fetch road', async () => {
  const origin = 'https://preview.example.com';
  const seen = [];
  const request = url => ({ url: () => url, method: () => 'GET', respond: async response => response });
  const fetcher = async (url, options) => {
    seen.push({ url, options });
    return new Response('<h1>Title</h1>', { headers: { 'content-type': 'text/html' } });
  };
  assert.equal((await proxyPreviewRequest(request('https://127.0.0.1/'), origin, fetcher)).status, 403);
  assert.equal(seen.length, 0);
  const allowed = await proxyPreviewRequest(request(`${origin}/`), origin, fetcher);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.toString(), '<h1>Title</h1>');
  assert.equal(seen[0].options.redirect, 'manual');
  const redirected = await proxyPreviewRequest(request(`${origin}/jump`), origin,
    async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }));
  assert.equal(redirected.status, 403);
});
