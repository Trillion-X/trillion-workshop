// Isolated caller fixture only. Replaces HTTPS before the actual descriptor's
// Node entry loads; no socket, provider, vault, or account is used by this test.
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
https.request = (url, options, receive) => {
  assert.equal(url.href, 'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.authorization, 'Bearer synthetic-held-token-never-returned');
  const request = new EventEmitter();
  request.destroy = error => { if (error) request.emit('error', error); };
  request.end = body => {
    const sent = JSON.parse(Buffer.from(body).toString());
    assert.deepEqual(sent.variables, { a: 'a'.repeat(32), s: '2026-02-01', u: '2026-02-28' });
    const incoming = Readable.from([Buffer.from(process.env.SYNTHETIC_PROVIDER_BODY)]);
    incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' }; incoming.rawHeaders = ['Content-Type', 'application/json'];
    process.nextTick(() => receive(incoming));
  };
  return request;
};
require('node:module').syncBuiltinESMExports();
