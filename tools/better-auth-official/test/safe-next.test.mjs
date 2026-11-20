// tools/better-auth-official/test/safe-next.test.mjs
//
// The return path after sign-in stays on this origin. These are the assertions old trillion-rust src/account/sign_in/routes.rs made for
// `safe_next` (2b8b821a4, tests next_paths_stay_on_this_origin and a_base_path_is_kept_on_the_default_next), so the port keeps every one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../pages/safe-next.mjs';

test('next paths stay on this origin', () => {
  assert.equal(safeNext('/authorize/continue?request=ab'), '/authorize/continue?request=ab');
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext(null), '/');
  assert.equal(safeNext('https://evil.example/'), '/');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
  assert.equal(safeNext('relative'), '/');
  assert.equal(safeNext(''), '/');
  assert.equal(safeNext('/a\nSet-Cookie: x'), '/');
  assert.equal(safeNext('/a\u007fb'), '/', 'DEL is a control character');
});

test('a base path is kept on the default next', () => {
  assert.equal(safeNext(null, '/a/abc/'), '/a/abc/');
  assert.equal(safeNext('/a/abc/authorize', '/a/abc/'), '/a/abc/authorize');
});
