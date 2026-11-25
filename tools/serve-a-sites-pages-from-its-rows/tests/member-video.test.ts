// A member's file: the presigned link is signature version 4 exactly as the store checks it (the published example), only keys
// under a declared prefix are signed, and only a member gets a link; every answer is private, no-store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { filesStoreOf, memberFileAnswer, memberFilesOf, objectKeyOf, presignedGet, publicFileAnswer, publicFilesOf, publicKeyOf, storeKeyOf } from '../do-work/member-video.ts';
import { MemberPasses } from '../do-work/member-pass.ts';

test('the presigned link matches the published signature version 4 example byte for byte', () => {
  const url = presignedGet(
    { endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'examplebucket', style: 'host' },
    { id: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    'test.txt', 86400, new Date('2013-05-24T00:00:00Z'),
  );
  assert.equal(url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

const store = filesStoreOf({ endpoint: 'https://s3.us-west-004.example.test', region: 'us-west-004', bucket: 'lesson-files', style: 'path' });
const files = memberFilesOf({ path: '/member-files/', prefixes: ['lessons/'], link_seconds: 21600 });
const key = storeKeyOf('AWS_ACCESS_KEY_ID=key-id\nAWS_SECRET_ACCESS_KEY=key-secret\n');

test('only a key under a declared prefix with no empty, dot or dot-dot part is a member file', () => {
  assert.equal(objectKeyOf(files, '/member-files/lessons/one/video%201.mp4'), 'lessons/one/video 1.mp4');
  for (const path of ['/member-files/look/logo.png', '/member-files/lessons/../look/logo.png', '/member-files/lessons//x.mp4', '/member-files/lessons/%2e%2e/x', '/member-files/%E0%A4%A', '/other/lessons/x.mp4']) {
    assert.equal(objectKeyOf(files, path), null, path);
  }
});

test('a member gets 302 to a path-style link that lives link_seconds; anyone else 403; both private, no-store', () => {
  const now = new Date('2026-11-25T08:00:00Z');
  const yes = memberFileAnswer(store, files, key, 'lessons/one/video 1.mp4', { pass: 'p', subject: 's', teams: ['t'] }, now);
  assert.equal(yes.status, 302);
  assert.equal(yes.headers['cache-control'], 'private, no-store');
  const link = new URL(yes.headers.location);
  assert.equal(link.host, 's3.us-west-004.example.test');
  assert.equal(link.pathname, '/lesson-files/lessons/one/video%201.mp4');
  assert.equal(link.searchParams.get('X-Amz-Expires'), '21600');
  assert.equal(link.searchParams.get('X-Amz-Credential'), 'key-id/20261125/us-west-004/s3/aws4_request');
  assert.match(link.searchParams.get('X-Amz-Signature')!, /^[0-9a-f]{64}$/);
  assert.ok(!yes.headers.location.includes('key-secret'), 'the secret is never in the link');
  const no = memberFileAnswer(store, files, key, 'lessons/one/video 1.mp4', null, now);
  assert.equal(no.status, 403);
  assert.equal(no.headers['cache-control'], 'private, no-store');
  assert.equal(no.headers.location, undefined);
});

test('a public file is its site path under key_prefix, linked and kept a while, for anyone; any other path is not one', () => {
  const pub = publicFilesOf({ paths: ['/assets/', '/favicon.png'], key_prefix: 'site-files/', link_seconds: 604800, cache_seconds: 86400 });
  assert.equal(publicKeyOf(pub, '/assets/landing/side%20by%20side.mp4'), 'site-files/assets/landing/side by side.mp4');
  assert.equal(publicKeyOf(pub, '/favicon.png'), 'site-files/favicon.png');
  for (const path of ['/favicon.png/x', '/assets/../secrets', '/assets//x', '/members', '/assetsx/y']) assert.equal(publicKeyOf(pub, path), null, path);
  const answer = publicFileAnswer(store, pub, key, 'site-files/favicon.png', new Date('2026-11-25T09:00:00Z'));
  assert.equal(answer.status, 302);
  assert.equal(answer.headers['cache-control'], 'public, max-age=86400');
  assert.equal(new URL(answer.headers.location).pathname, '/lesson-files/site-files/favicon.png');
  assert.equal(new URL(answer.headers.location).searchParams.get('X-Amz-Expires'), '604800');
  assert.throws(() => publicFilesOf({ ...pub, cache_seconds: 400000 }), /half of link_seconds/);
  assert.throws(() => publicFilesOf({ ...pub, paths: ['assets'] }), /paths/);
  assert.equal(objectKeyOf(memberFilesOf({ path: '/member-files/', key_prefix: 'site-files/', prefixes: ['lessons/'], link_seconds: 3600 }), '/member-files/lessons/a.mp4'), 'site-files/lessons/a.mp4');
});

test('settings that would sign anything, or keep a link past 7 days, are refused', () => {
  assert.throws(() => memberFilesOf({ ...files, prefixes: [] }), /prefixes/);
  assert.throws(() => memberFilesOf({ ...files, prefixes: ['/'] }), /prefixes/);
  assert.throws(() => memberFilesOf({ ...files, link_seconds: 604801 }), /link_seconds/);
  assert.throws(() => filesStoreOf({ ...store, endpoint: 'http://s3.example.test' }), /endpoint/);
  assert.throws(() => storeKeyOf('AWS_ACCESS_KEY_ID=only-one'), /two lines/);
});

// A sign-in tool on loopback: its public keys and the pass it signs for a cookie, as the jwt plugin answers them.
async function signInWith(claims: Record<string, unknown>, { alg = 'EdDSA' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const header = Buffer.from(JSON.stringify({ alg, kid: 'k1', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
  const asked: string[] = [];
  const server = http.createServer((request, response) => {
    asked.push(request.url ?? '');
    if (request.url === '/api/auth/jwks') return response.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'EdDSA' }] }));
    if (request.url === '/api/auth/token' && request.headers.cookie === 'session=good') return response.end(JSON.stringify({ token }));
    response.writeHead(401).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, token, asked, signIn: { address, issuer: 'https://sign-in.example.test', audience: 'https://site.example.test', team_claim: 'team_ids', members_team: 'team-members' } };
}

const seconds = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: 'https://sign-in.example.test', aud: 'https://site.example.test', sub: 'user-1', exp: seconds() + 600, team_ids: ['team-other', 'team-members'] });

test('a signed-in member of the members team is a member, with their own pass', async () => {
  const s = await signInWith(good());
  try {
    const member = await new MemberPasses(s.signIn).memberOfCookie('session=good');
    assert.deepEqual(member, { pass: s.token, subject: 'user-1', teams: ['team-other', 'team-members'] });
  } finally { s.server.close(); }
});

test('no cookie, an unknown session, another team, an ended pass, another issuer or audience, or a forged signature is not a member', async () => {
  for (const [why, claims] of [
    ['another team', { ...good(), team_ids: ['team-other'] }],
    ['ended', { ...good(), exp: seconds() - 1 }],
    ['issuer', { ...good(), iss: 'https://elsewhere.example.test' }],
    ['audience', { ...good(), aud: 'https://elsewhere.example.test' }],
    ['no team claim', { ...good(), team_ids: undefined }],
  ] as const) {
    const s = await signInWith(claims as Record<string, unknown>);
    try {
      assert.equal(await new MemberPasses(s.signIn).memberOfCookie('session=good'), null, why);
    } finally { s.server.close(); }
  }
  const s = await signInWith(good());
  try {
    const passes = new MemberPasses(s.signIn);
    assert.equal(await passes.memberOfCookie(undefined), null, 'no cookie');
    assert.equal(await passes.memberOfCookie('session=bad'), null, 'unknown session');
    const [h, b] = s.token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...good(), sub: 'someone-else' })).toString('base64url')}.${s.token.split('.')[2]}`;
    assert.equal(await passes.memberOfPass(forged), null, 'forged claims');
    assert.equal(await passes.memberOfPass(`${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${b}.`), null, 'alg none');
  } finally { s.server.close(); }
});
