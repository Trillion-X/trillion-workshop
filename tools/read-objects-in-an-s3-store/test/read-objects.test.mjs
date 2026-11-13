// tools/read-objects-in-an-s3-store/test/read-objects.test.mjs
//
// Synthetic only: a made-up endpoint, bucket and key. The signing key is the published AWS Signature Version 4 example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signingKey, signRequest, parseListing, endpointOrigin, readObjects } from '../do-work/read-objects.mjs';

const STORE = {
  keyId: 'EXAMPLEKEYID',
  secret: 'EXAMPLESECRETVALUE',
  endpoint: 'https://example-account.r2.example.test',
  bucket: 'example-bucket',
};

test('the signing key matches the published AWS Signature Version 4 example', () => {
  const key = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
  assert.equal(key.toString('hex'), 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
});

test('a signed request names its scope, its signed headers and the payload hash', () => {
  const headers = signRequest({
    method: 'GET',
    url: 'https://example-account.r2.example.test/example-bucket?list-type=2&prefix=a%2F',
    keyId: STORE.keyId,
    secret: STORE.secret,
    now: new Date('2026-11-12T12:00:00Z'),
  });
  assert.equal(headers['x-amz-date'], '20261112T120000Z');
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID\/20261112\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(headers['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('a listing page answers its objects, truncation and the next token', () => {
  const xml = '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok-1</NextContinuationToken>'
    + '<Contents><Key>index.html</Key><Size>120</Size><LastModified>2026-11-01T00:00:00.000Z</LastModified></Contents>'
    + '<Contents><Key>a&amp;b/style.css</Key><Size>42</Size><LastModified>2026-11-02T00:00:00.000Z</LastModified></Contents>'
    + '</ListBucketResult>';
  assert.deepEqual(parseListing(xml), {
    objects: [
      { key: 'index.html', size: 120, last_modified: '2026-11-01T00:00:00.000Z' },
      { key: 'a&b/style.css', size: 42, last_modified: '2026-11-02T00:00:00.000Z' },
    ],
    truncated: true,
    next_token: 'tok-1',
  });
});

test('an endpoint that is not a bare https root is refused before any request', () => {
  assert.equal(endpointOrigin('https://example-account.r2.example.test/'), 'https://example-account.r2.example.test');
  assert.throws(() => endpointOrigin('http://example.test'), /must be an https address/);
  assert.throws(() => endpointOrigin('https://example.test/path'), /no path/);
  assert.throws(() => endpointOrigin('not a url'), /not a web address/);
});

test('a list call sends one signed GET to the connection endpoint only', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>index.html</Key><Size>5</Size><LastModified>2026-11-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>', { status: 200 });
  };
  const answer = await readObjects({ action: 'list', prefix: 'site/' }, { store: STORE, fetchImpl, now: new Date('2026-11-12T12:00:00Z') });
  assert.deepEqual(answer.objects, [{ key: 'index.html', size: 5, last_modified: '2026-11-01T00:00:00.000Z' }]);
  assert.equal(seen.length, 1);
  const target = new URL(seen[0].url);
  assert.equal(target.origin, 'https://example-account.r2.example.test');
  assert.equal(target.pathname, '/example-bucket');
  assert.equal(target.searchParams.get('prefix'), 'site/');
  assert.equal(seen[0].init.redirect, 'error');
  assert.match(seen[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID\//);
});

test('a get call returns the bytes as base64 and a refused key names the reconnect step', async () => {
  const fetchImpl = async () => new Response('<h1>Hi</h1>', { status: 200, headers: { 'content-type': 'text/html' } });
  const answer = await readObjects({ action: 'get', key: 'index.html' }, { store: STORE, fetchImpl });
  assert.deepEqual(answer, { key: 'index.html', size: 11, content_type: 'text/html', base64: Buffer.from('<h1>Hi</h1>').toString('base64') });

  const refused = async () => new Response('', { status: 403 });
  await assert.rejects(readObjects({ action: 'list' }, { store: STORE, fetchImpl: refused }), /Connect the store again/);
});

test('a missing key or bucket name refuses before any request', async () => {
  const fetchImpl = async () => { throw new Error('no request should be made'); };
  await assert.rejects(readObjects({ action: 'list' }, { store: { ...STORE, keyId: '' }, fetchImpl }), /No store key/);
  await assert.rejects(readObjects({ action: 'list' }, { store: { ...STORE, bucket: 'Bad_Bucket' }, fetchImpl }), /valid bucket name/);
});
