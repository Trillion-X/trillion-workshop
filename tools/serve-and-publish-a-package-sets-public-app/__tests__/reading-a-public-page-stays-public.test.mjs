// This reaches the network, so what it REFUSES matters more than what it
// reads. Pointed at a loopback or private address it would become a way to
// reach things inside the network that the caller could not otherwise reach,
// using this process's position rather than their own. That is the whole risk
// and these are the checks that hold it shut.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPublicWebAddress, readOnePublicPage } from '../processes/read-one-public-page.mjs';

test('reads a public web address', () => {
  for (const address of ['https://docs.stripe.com/x', 'https://example.com', 'https://example.com:8443/a']) {
    assert.equal(isPublicWebAddress(address), true, address);
  }
});

test('refuses anything that is not encrypted', () => {
  // A plain request can be read and rewritten in transit, and a page read that
  // way is not evidence of anything.
  for (const address of ['http://example.com', 'ftp://example.com', 'file:///opt/a', 'not a url', '']) {
    assert.equal(isPublicWebAddress(address), false, String(address));
  }
});

test('refuses addresses that only resolve from inside', () => {
  // The dangerous case: this process can reach a service on this machine or
  // this network that the caller cannot. Reading one on their behalf would
  // lend them that position.
  for (const address of [
    'https://localhost/a', 'https://app.localhost/a', 'https://127.0.0.1/a', 'https://127.9.9.9/a',
    'https://10.0.0.5/a', 'https://192.168.1.20/a', 'https://169.254.10.1/a',
    'https://172.16.0.1/a', 'https://172.31.255.254/a',
  ]) {
    assert.equal(isPublicWebAddress(address), false, address);
  }
});

test('does not mistake a public address for a private one', () => {
  // 172.16/12 is 172.16 through 172.31. Matching on `172.1` would refuse
  // 172.1.x and 172.15.x, which are public, and admit 172.20.x, which is not.
  for (const address of ['https://172.15.0.1/a', 'https://172.32.0.1/a', 'https://172.1.0.1/a']) {
    assert.equal(isPublicWebAddress(address), true, address);
  }
  assert.equal(isPublicWebAddress('https://172.20.0.1/a'), false);
});

test('a redirect may not carry it somewhere it would have refused', () => {
  // Without this, any public address that redirects becomes a way through to
  // an internal one, and the checks above are decoration.
  const reply = {
    status: 302,
    headers: { get: (name) => (name === 'location' ? 'https://127.0.0.1/secret' : null) },
  };
  return assert.rejects(
    readOnePublicPage('https://example.com/start', async () => reply),
    /not a public web address/i,
  );
});

test('stops rather than following a redirect loop', () => {
  const reply = {
    status: 302,
    headers: { get: (name) => (name === 'location' ? 'https://example.com/again' : null) },
  };
  return assert.rejects(
    readOnePublicPage('https://example.com/start', async () => reply),
    /kept redirecting/i,
  );
});

test('says so when a page answers with a failure', () => {
  return assert.rejects(
    readOnePublicPage('https://example.com/a', async () => ({ status: 404, ok: false, headers: { get: () => null } })),
    /answered 404/,
  );
});

test('returns what the page said', async () => {
  const text = await readOnePublicPage('https://example.com/a', async () => ({
    status: 200, ok: true, headers: { get: () => null }, text: async () => 'the page',
  }));
  assert.equal(text, 'the page');
});
