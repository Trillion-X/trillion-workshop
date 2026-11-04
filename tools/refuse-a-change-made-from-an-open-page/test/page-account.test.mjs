// test/page-account.test.mjs
// A write from a page drawn for another account than the signed-in one is refused with plain words (F-0208).
import assert from 'node:assert/strict';
import test from 'node:test';
import { pageAccountRefusal, pageAccountHeader } from '../src/page-account.mjs';
import { keptAnswerStore } from '../src/kept-answers.mjs';

const ask = (method, path, store) => new Request(`https://app.gettrillion.ai${path}`, { method, headers: store ? { [pageAccountHeader]: store } : {} });

test('a write from a page for the signed-in account passes; one for another account is refused', () => {
  assert.equal(pageAccountRefusal(ask('POST', '/work/api/ai-work', keptAnswerStore('user-a')), 'user-a'), null);
  const refused = pageAccountRefusal(ask('POST', '/work/api/ai-work', keptAnswerStore('user-a')), 'user-b');
  assert.equal(refused.status, 409);
  assert.match(refused.error, /account signed in on this browser changed/);
  console.log('readback', JSON.stringify(refused));
});

test('reads, unnamed writes and other paths are never refused', () => {
  assert.equal(pageAccountRefusal(ask('GET', '/work/api/screens', keptAnswerStore('user-a')), 'user-b'), null);
  assert.equal(pageAccountRefusal(ask('POST', '/work/api/ai-work'), 'user-b'), null);
  assert.equal(pageAccountRefusal(ask('POST', '/mcp/api/anything', keptAnswerStore('user-a')), 'user-b'), null);
});
