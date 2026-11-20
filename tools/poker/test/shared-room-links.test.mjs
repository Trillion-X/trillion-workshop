// The browser join link and the loopback flag for the Connect devices card. Every host and route here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserUrlForBase, browserUrlForRoute, isLoopbackUrl, makeSharedRoomOpenLinks, normalizeRoutePath,
} from '../read-data/shared-room-links.mjs';

test('a route gets a leading slash, an empty route is the root, spaces are trimmed', () => {
  assert.equal(normalizeRoutePath('share'), '/share');
  assert.equal(normalizeRoutePath('/share'), '/share');
  assert.equal(normalizeRoutePath('  room/7  '), '/room/7');
  assert.equal(normalizeRoutePath(''), '/');
  assert.equal(normalizeRoutePath('   '), '/');
  assert.equal(normalizeRoutePath(undefined), '/');
});

test('a route is joined to a base address with or without its trailing slash', () => {
  assert.equal(browserUrlForBase('/room', 'https://room.example.test'), 'https://room.example.test/room');
  assert.equal(browserUrlForBase('room', 'https://room.example.test/'), 'https://room.example.test/room');
  assert.equal(browserUrlForBase(undefined, 'https://room.example.test'), 'https://room.example.test/');
});

test('a base address with its own path keeps that path when the route is joined', () => {
  assert.equal(browserUrlForBase('/room', 'https://room.example.test/app'), 'https://room.example.test/app/room');
  assert.equal(browserUrlForBase('/room', 'https://room.example.test/app/'), 'https://room.example.test/app/room');
  assert.equal(browserUrlForBase('/', 'https://room.example.test/app'), 'https://room.example.test/app/');
});

test('without a base the link comes from the page origin and route, or the page path when no route is given', () => {
  const location = { origin: 'https://page.example.test/', pathname: '/here' };
  assert.equal(browserUrlForRoute('/join', location), 'https://page.example.test/join');
  assert.equal(browserUrlForRoute(undefined, location), 'https://page.example.test/here');
  assert.equal(browserUrlForRoute('join', { origin: 'https://page.example.test' }), 'https://page.example.test/join');
  assert.equal(browserUrlForRoute('/join', null), '/join');
});

test('loopback hosts are flagged: 127.0.0.1, localhost, ::1 and [::1], with or without a port', () => {
  for (const value of ['http://127.0.0.1:8000/join', 'http://localhost/join', 'http://[::1]:3000/', 'http://[::1]/']) {
    assert.equal(isLoopbackUrl(value), true, value);
  }
});

test('a public host, a lookalike host and an unparseable value are not loopback', () => {
  assert.equal(isLoopbackUrl('https://room.example.test/join'), false);
  assert.equal(isLoopbackUrl('https://localhost.example.test/join'), false);
  assert.equal(isLoopbackUrl('https://127.0.0.10/join'), false);
  assert.equal(isLoopbackUrl('http://[::2]/'), false);
  assert.equal(isLoopbackUrl('not a link at all'), false);
});

test('the open-links bundle gives the base link and flags a loopback base', () => {
  assert.deepEqual(
    makeSharedRoomOpenLinks({ routePath: '/connect', browserBaseUrl: 'https://room.example.test' }),
    { browserUrl: 'https://room.example.test/connect', browserHostIsLoopback: false },
  );
  assert.deepEqual(
    makeSharedRoomOpenLinks({ routePath: '/connect', browserBaseUrl: 'http://localhost:8000' }),
    { browserUrl: 'http://localhost:8000/connect', browserHostIsLoopback: true },
  );
});

test('the open-links bundle without a base uses the page location and flags a loopback page', () => {
  assert.deepEqual(
    makeSharedRoomOpenLinks({ location: { origin: 'http://127.0.0.1:9000', pathname: '/x' } }),
    { browserUrl: 'http://127.0.0.1:9000/x', browserHostIsLoopback: true },
  );
});
