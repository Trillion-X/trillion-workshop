// The native post owner (src/native-post-owner.mjs) tells the post lifecycle that an approval was pressed by the person
// only when the command comes from the person's own signed-in page (a session sign-in that is not a look): an AI app's
// key, or a look at someone's account, never approves a post that reaches someone (src/social-posts.mjs invariant 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { nativePostOwner } from '../../social-posts/native-post-owner.mjs';

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
