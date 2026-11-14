import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRetirePublicRoute, replyRetiredPublicRoute } from './public-route-retirement.mjs';

const publicHosts = [
  'gettrillion.ai',
  'www.gettrillion.ai',
  'trillion.fly.dev',
  'localhost',
  '127.0.0.1',
];

test('malformed descriptions cannot widen a retirement to every route', () => {
  for (const paths of [null, '/app', {}, ['', null, 42]]) {
    assert.equal(shouldRetirePublicRoute({
      method: 'GET', publicHost: true, pathname: '/app', exactPaths: paths, pathPrefixes: paths,
    }), false);
  }
});

test('HEAD returns the same status and length as GET without a body', () => {
  const replies = [];
  for (const method of ['GET', 'HEAD']) {
    const result = {};
    replyRetiredPublicRoute({ method }, {
      writeHead(status, headers) { Object.assign(result, { status, headers }); },
      end(body) { result.body = body; },
    });
    replies.push(result);
  }
  assert.equal(replies[0].status, 404);
  assert.equal(replies[0].body, 'Not found\n');
  assert.equal(replies[1].body, undefined);
  assert.deepEqual(replies[0].headers, replies[1].headers);
  assert.equal(replies[0].headers['Content-Length'], Buffer.byteLength(replies[0].body));
});

for (const host of publicHosts) {
  test(`retires every nested public job route on ${host}`, () => {
    for (const method of ['GET', 'HEAD']) {
      assert.equal(shouldRetirePublicRoute({
        method,
        publicHost: true,
        pathname: '/app/run/anything',
        pathPrefixes: ['/app/run/'],
      }), true);
    }
  });
}

test('preserves the app root and refuses non-public or mutating requests', () => {
  assert.equal(shouldRetirePublicRoute({
    method: 'GET', publicHost: true, pathname: '/app', pathPrefixes: ['/app/run/'],
  }), false);
  assert.equal(shouldRetirePublicRoute({
    method: 'GET', publicHost: false, pathname: '/app/run/anything', pathPrefixes: ['/app/run/'],
  }), false);
  assert.equal(shouldRetirePublicRoute({
    method: 'POST', publicHost: true, pathname: '/app/run/anything', pathPrefixes: ['/app/run/'],
  }), false);
});

test('supports exact retired pages without widening their descendants', () => {
  assert.equal(shouldRetirePublicRoute({
    method: 'GET',
    publicHost: true,
    pathname: '/production/the-first-missing-step',
    exactPaths: ['/production/the-first-missing-step'],
  }), true);
  assert.equal(shouldRetirePublicRoute({
    method: 'GET',
    publicHost: true,
    pathname: '/production/the-first-missing-step/child',
    exactPaths: ['/production/the-first-missing-step'],
  }), false);
});
