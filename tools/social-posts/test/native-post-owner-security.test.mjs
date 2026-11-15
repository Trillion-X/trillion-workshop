// The native post owner (src/native-post-owner.mjs) tells the post lifecycle that an approval was pressed by the person
// only when the command comes from the person's own signed-in page (a session sign-in that is not a look): an AI app's
// key, or a look at someone's account, never approves a post that reaches someone (src/social-posts.mjs invariant 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '#tools/keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { nativePostOwner } from '../native-post-owner.mjs';
import { loadPostPlaces } from '../read-data/native-post-place-source.mjs';
import defaults from '#tools/marketplace-defaults/src/marketplace-defaults.json' with { type: 'json' };

function owner(claims) {
  const store = localStore(':memory:');
  let at = Date.parse('2026-10-17T12:00:00Z');
  const { operations } = nativePostOwner({
    env: {}, records: store.eeaf, shop: { run: async () => { throw new Error('nothing is published here'); } },
    current: async () => {}, context: () => ({ recorder: { app: claims.app }, claims, request_key: 'request-one' }),
    connections: async () => [{ connection_id: 'youtube-one', vendor: 'youtube', can_send: true }],
    plainFields: async () => null, heldValue: async () => null, connectLink: async () => null, files: { locate: async () => null },
    later: async () => {}, serviceOrigin: () => 'https://service.example', now: () => new Date((at += 1000)),
  });
  return async (path, body) => (await operations['posts:request']({ path, method: 'POST', body })).body;
}

test('only the person\'s own signed-in page approves a post that reaches someone', async () => {
  for (const [claims, approves] of [
    [{ sign_in: 'session:page-one', app: 'You, in Trillion' }, true],
    [{ sign_in: 'key:agent-one', app: 'You, in Trillion' }, false],
    [{ sign_in: 'session:viewer-one', app: 'You, in Trillion', approved_by: 'view-as', look: { grant: 'g', viewer: 'v' } }, false],
  ]) {
    const ask = owner(claims);
    const { post } = await ask('/posts/draft', { caption: 'Hello @proof_ana, your seed round thread helped me', destinations: ['youtube-one'] });
    const answer = await ask('/posts/approve', { post_id: post.post_id });
    assert.equal(answer.post?.status === 'approved', approves, `${claims.sign_in}${claims.look ? ' (a look)' : ''}: ${answer.error ?? answer.post.status}`);
    if (!approves) assert.match(answer.error, /approved only by the person/);
  }
});

test('published post places require the admitted host source and never revive shipped places after withdrawal', async () => {
  const account = defaults.default_publishers.find(row => row.account?.from === 'env').account;
  const env = { [account.key]: 'publisher-account', PERSON: {} };
  await assert.rejects(loadPostPlaces(env), error => error.status === 503
    && error.code === 'marketplace_content_source_unavailable');
  let checked = 0;
  assert.deepEqual(await loadPostPlaces(env, { source: async () => [], current: async () => { checked++; } }), []);
  assert.equal(checked, 1);
  const revoked = new Error('The admitted run was revoked.');
  await assert.rejects(loadPostPlaces(env, { source: async () => [], current: async () => { throw revoked; } }),
    error => error === revoked);
  assert.ok((await loadPostPlaces({})).length > 0);
});

test('request-body origin claims never turn an app or a view into the person', async () => {
  for (const claims of [
    { sign_in: 'key:agent-one', app: 'You, in Trillion' },
    { sign_in: 'session:view-one', app: 'You, in Trillion', approved_by: 'view-as' },
    { sign_in: 'session:view-two', app: 'You, in Trillion', look: null },
  ]) {
    const ask = owner(claims);
    const { post } = await ask('/posts/draft', { caption: 'Hello @proof_ana', destinations: ['youtube-one'] });
    const answer = await ask('/posts/approve', { post_id: post.post_id, by_person: true,
      origin: 'signed-in-page', approved_by: 'person', 'x-trillion-typed-on-signed-in-screen': 'yes' });
    assert.equal(answer.post?.status === 'approved', false);
    assert.match(answer.error, /approved only by the person/);
  }
});

test('the native publisher closure loads the actual SDK and both local adapters', async () => {
  const { postPublishers, postSdk } = await import('../read-data/native-post-publishers.mjs');
  assert.equal(typeof postSdk.createSocial, 'function');
  assert.equal(typeof postSdk.connectedAccountRef, 'function');
  assert.equal(typeof postPublishers['facebook-page'], 'function');
  assert.equal(typeof postPublishers.substack, 'function');
});
