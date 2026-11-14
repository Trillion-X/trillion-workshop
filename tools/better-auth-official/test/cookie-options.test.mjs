// tools/better-auth-official/test/cookie-options.test.mjs
//
// The session cookie is named exactly as settings.json says. Better Auth puts __Secure- in front of every cookie name on an
// https base URL, so a name that already carries its own prefix (__Host-, __Secure-) keeps it alone and stays Secure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieOptions } from '../cookie-options.mjs';

test('a __Host- name on https is used as it is, every cookie Secure, with no second prefix', () => {
  assert.deepEqual(cookieOptions({ session_cookie_name: '__Host-trillion_session', base_url: 'https://app.example.test' }), {
    useSecureCookies: false,
    defaultCookieAttributes: { secure: true },
    cookies: { session_token: { name: '__Host-trillion_session' } },
  });
});

test('a plain name keeps Better Auth\'s own secure prefix rule', () => {
  assert.deepEqual(cookieOptions({ session_cookie_name: 'trillion_session', base_url: 'https://app.example.test' }), {
    cookies: { session_token: { name: 'trillion_session' } },
  });
});

test('a prefixed name on plain http (a computer\'s own loopback test) is not marked Secure', () => {
  assert.deepEqual(cookieOptions({ session_cookie_name: '__Host-trillion_session', base_url: 'http://localhost:8792' }).defaultCookieAttributes, { secure: false });
});
