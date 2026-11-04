import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlerRoute } from '../src/crawlers.mjs';

test('robots keeps the existing content signals and advertises the host sitemap', async () => {
  const response = crawlerRoute(new Request('https://app.gettrillion.ai/robots.txt'), { origin: 'https://app.gettrillion.ai' });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS/);
  assert.match(text, /User-agent: \*/);
  assert.match(text, /Allow: \/\n/);
  assert.match(text, /Sitemap: https:\/\/app\.gettrillion\.ai\/share\/sitemap\.xml/);
});

test('only current crawler verification files return public contents', async () => {
  const indexNow = crawlerRoute(new Request('https://app.gettrillion.ai/20009f9d870f048936b64324566673c2.txt'), { origin: 'https://app.gettrillion.ai' });
  assert.equal(await indexNow.text(), '20009f9d870f048936b64324566673c2');
  const retiredGoogle = crawlerRoute(new Request('https://app.gettrillion.ai/google57061d1cfeadff63.html'), { origin: 'https://app.gettrillion.ai' });
  assert.equal(retiredGoogle, null);
});

test('crawler routes support HEAD and leave unrelated requests to the worker', () => {
  const head = crawlerRoute(new Request('https://app.gettrillion.ai/robots.txt', { method: 'HEAD' }), { origin: 'https://app.gettrillion.ai' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(crawlerRoute(new Request('https://app.gettrillion.ai/robots.txt', { method: 'POST' }), { origin: 'https://app.gettrillion.ai' }), null);
  assert.equal(crawlerRoute(new Request('https://app.gettrillion.ai/anything'), { origin: 'https://app.gettrillion.ai' }), null);
});
