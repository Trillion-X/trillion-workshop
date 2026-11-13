import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSitePage } from '../src/public-site-pages.mjs';

for (const path of [
  '/articles',
  '/articles/prioritization-techniques-which-one-to-use-when?from=work',
  '/articles/prioritization-techniques-which-one-to-use-when.md',
  '/articles/prioritization-techniques-which-one-to-use-when/share.png',
  '/articles/feed.xml',
  '/articles/latest.json',
]) {
  test(`a signed-in app article read moves to its public owner: ${path}`, () => {
    for (const method of ['GET', 'HEAD']) {
      const response = publicSitePage(new Request(`https://app.gettrillion.ai${path}`, { method }));
      assert.equal(response?.status, 301);
      assert.equal(response?.headers.get('location'), `https://gettrillion.ai${path}`);
    }
  });
}

test('unrelated reads and every write stay with the app router', () => {
  assert.equal(publicSitePage(new Request('https://app.gettrillion.ai/work')), null);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(publicSitePage(new Request('https://app.gettrillion.ai/articles', { method })), null);
  }
});
