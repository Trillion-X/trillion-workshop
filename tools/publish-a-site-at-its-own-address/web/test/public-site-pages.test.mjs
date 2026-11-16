import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSitePage } from '../src/public-site-pages.mjs';

const PUBLIC = 'https://www.example.com';
const APP = 'https://app.example.com';

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
      const response = publicSitePage(new Request(`${APP}${path}`, { method }), PUBLIC);
      assert.equal(response?.status, 301);
      assert.equal(response?.headers.get('location'), `${PUBLIC}${path}`);
    }
  });
}

test('unrelated reads and every write stay with the app router', () => {
  assert.equal(publicSitePage(new Request(`${APP}/work`), PUBLIC), null);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(publicSitePage(new Request(`${APP}/articles`, { method }), PUBLIC), null);
  }
});

test('without the public site origin the page refuses to answer', () => {
  assert.throws(() => publicSitePage(new Request(`${APP}/articles`)), /public site origin/);
});
