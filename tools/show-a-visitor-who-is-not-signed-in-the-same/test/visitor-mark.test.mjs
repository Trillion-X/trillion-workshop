// tools/show-a-visitor-who-is-not-signed-in-the-same: the visitor mark, read and made. The malformed-mark case is the
// old held test's own assertion (src/visitor-mark.mjs, held test visitor-offers.test.mjs, "a malformed mark is skipped").
import test from 'node:test';
import assert from 'node:assert/strict';
import { VISITOR_COOKIE, newVisitor, visitorOf } from '../do-work/visitor-mark.mjs';

test('a malformed mark is skipped for a well-formed one', () => {
  const good = 'cd'.repeat(16);
  assert.equal(visitorOf(new Request('https://x', { headers: { cookie: `${VISITOR_COOKIE}=nope; ${VISITOR_COOKIE}=${good}` } })), good);
  assert.equal(visitorOf(new Request('https://x', { headers: { cookie: `${VISITOR_COOKIE}=nope` } })), null);
});

test('no cookie means no mark', () => {
  assert.equal(visitorOf(new Request('https://x')), null);
});

test('a made mark is 32 lowercase hex characters and differs each time', () => {
  const one = newVisitor();
  const two = newVisitor();
  assert.match(one, /^[0-9a-f]{32}$/);
  assert.match(two, /^[0-9a-f]{32}$/);
  assert.notEqual(one, two);
  assert.equal(visitorOf(new Request('https://x', { headers: { cookie: `${VISITOR_COOKIE}=${one}` } })), one);
});
